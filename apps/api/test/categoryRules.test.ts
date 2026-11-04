import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseUsBankStatement } from "@kuberaxis/parser";
import type pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { applyRules } from "../src/categoryRules.js";
import { importStatement } from "../src/importStatement.js";
import { buildServer } from "../src/server.js";
import type { CategoryRule, CategoryRuleInput, RulePreview, TransactionRow } from "../src/types.js";
import { openTestDatabase, truncateAll } from "./testDb.js";

const SAMPLE = fileURLToPath(new URL("../../../test-data/usbank-sample-statement.pdf", import.meta.url));

const testPool = await openTestDatabase("kuberaxis_test_rules");
if (!testPool) console.warn("Skipping category rule tests: needs Postgres (npm run db:up)");

describe.skipIf(!testPool)("category rules", () => {
  const pool = testPool!;
  const app = buildServer({ pool, maxUploadBytes: 1, logger: false });
  let importId: number;
  let categories: Record<string, number>;

  /** Adds a transaction with the given description and amount in dollars; returns its id. */
  async function addTransaction(description: string, amount: number, details: string[] = []): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO transactions (account_id, import_id, posted_date, section, type, description, details, amount_cents, fingerprint, occurrence)
       VALUES (1, $1, '2026-10-05', 'Card Withdrawals', 'Debit Purchase', $2, $3, $4, gen_random_uuid()::text, 1)
       RETURNING id::text`,
      [importId, description, details, Math.round(amount * 100)],
    );
    return rows[0]!.id;
  }

  beforeEach(async () => {
    await truncateAll(pool);
    await pool.query("INSERT INTO accounts (bank, name) VALUES ('Test', 'Checking')");
    importId = (
      await pool.query<{ id: number }>(
        "INSERT INTO imports (file_name, file_sha256, period_start, period_end) VALUES ('t.pdf', 'x', '2026-10-01', '2026-10-31') RETURNING id",
      )
    ).rows[0]!.id;
    const { rows } = await pool.query<{ id: number; name: string }>(
      "INSERT INTO categories (name) VALUES ('Groceries'), ('Fuel'), ('Refunds'), ('Shopping') RETURNING id, name",
    );
    categories = Object.fromEntries(rows.map((r) => [r.name, r.id]));
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const rule = (patch: Partial<CategoryRuleInput> & Pick<CategoryRuleInput, "pattern" | "categoryId">): CategoryRuleInput => ({
    matchType: "contains",
    direction: "any",
    priority: 100,
    enabled: true,
    ...patch,
  });
  const createRule = async (input: CategoryRuleInput) => {
    const response = await app.inject({ method: "POST", url: "/api/rules", payload: input });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<CategoryRule>();
  };
  const categoryOf = async (id: string) =>
    (
      await pool.query<{ name: string | null }>(
        "SELECT c.name FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = $1",
        [id],
      )
    ).rows[0]!.name;

  it("uses the first enabled matching rule by priority, honoring direction and regex", async () => {
    const fuel = await addTransaction("SAFEWAY FUEL 3248", -40);
    const groceries = await addTransaction("Safeway #1234", -80);
    const refund = await addTransaction("SAFEWAY #1234", 12);
    const inDetails = await addTransaction("To Privacycom", -23, ["REF=000000000000000N00 000000000PwP AMAZONAbCdEfGhIjKlMnO"]);
    const untouched = await addTransaction("SOMETHING ELSE", -5);

    await createRule(rule({ pattern: "safeway", categoryId: categories.Groceries!, direction: "debit" }));
    await createRule(rule({ pattern: "SAFEWAY FUEL", categoryId: categories.Fuel!, priority: 10 }));
    await createRule(rule({ pattern: "SAFEWAY", categoryId: categories.Refunds!, direction: "credit" }));
    await createRule(rule({ pattern: "PwP AMAZON", categoryId: categories.Shopping!, matchType: "regex" }));
    await createRule(rule({ pattern: "ELSE", categoryId: categories.Shopping!, enabled: false }));

    const result = await app.inject({ method: "POST", url: "/api/rules/apply", payload: {} });
    expect(result.json()).toEqual({ categorized: 4, uncategorized: 1 });
    expect(await categoryOf(fuel)).toBe("Fuel");
    expect(await categoryOf(groceries)).toBe("Groceries");
    expect(await categoryOf(refund)).toBe("Refunds");
    expect(await categoryOf(inDetails)).toBe("Shopping");
    expect(await categoryOf(untouched)).toBeNull();

    const rules = (await app.inject({ method: "GET", url: "/api/rules" })).json<CategoryRule[]>();
    expect(rules.map((r) => [r.pattern, r.matchCount])).toEqual([
      ["SAFEWAY FUEL", 1],
      ["safeway", 1],
      ["SAFEWAY", 1],
      ["PwP AMAZON", 1],
      ["ELSE", 0],
    ]);
  });

  it("leaves transactions categorized by hand or itemized alone, and reapply only redoes rule categories", async () => {
    const manual = await addTransaction("SAFEWAY", -10);
    const itemized = await addTransaction("SAFEWAY", -20);
    const byRule = await addTransaction("SAFEWAY", -30);
    await app.inject({ method: "PUT", url: `/api/transactions/${manual}/category`, payload: { categoryId: categories.Shopping } });
    await app.inject({
      method: "PUT",
      url: `/api/transactions/${itemized}/items`,
      payload: { items: [{ description: "x", amount: -20, categoryId: null }] },
    });

    const groceries = await createRule(rule({ pattern: "SAFEWAY", categoryId: categories.Groceries! }));
    expect(await applyRules(pool)).toBe(1);
    expect([await categoryOf(manual), await categoryOf(itemized), await categoryOf(byRule)]).toEqual(["Shopping", null, "Groceries"]);

    await app.inject({
      method: "PUT",
      url: `/api/rules/${groceries.id}`,
      payload: rule({ pattern: "SAFEWAY", categoryId: categories.Fuel! }),
    });
    expect((await app.inject({ method: "POST", url: "/api/rules/apply", payload: {} })).json().categorized).toBe(0);
    expect((await app.inject({ method: "POST", url: "/api/rules/apply", payload: { reapply: true } })).json().categorized).toBe(1);
    expect([await categoryOf(manual), await categoryOf(byRule)]).toEqual(["Shopping", "Fuel"]);

    const rows = (await app.inject({ method: "GET", url: "/api/transactions" })).json<TransactionRow[]>();
    expect(rows.find((t) => t.id === byRule)).toMatchObject({ categoryName: "Fuel", categoryRuleId: groceries.id });
    expect(rows.find((t) => t.id === manual)).toMatchObject({ categoryName: "Shopping", categoryRuleId: null });
  });

  it("keeps the category of transactions whose rule is deleted", async () => {
    const id = await addTransaction("SAFEWAY", -10);
    const created = await createRule(rule({ pattern: "SAFEWAY", categoryId: categories.Groceries! }));
    await applyRules(pool);
    expect((await app.inject({ method: "DELETE", url: `/api/rules/${created.id}` })).json()).toEqual({ ok: true });
    expect(await categoryOf(id)).toBe("Groceries");
    expect((await app.inject({ method: "DELETE", url: `/api/rules/${created.id}` })).statusCode).toBe(404);
  });

  it("rejects bad rules", async () => {
    const post = (input: object) => app.inject({ method: "POST", url: "/api/rules", payload: input });
    expect((await post(rule({ pattern: "(unclosed", matchType: "regex", categoryId: categories.Fuel! }))).statusCode).toBe(422);
    expect((await post(rule({ pattern: "   ", categoryId: categories.Fuel! }))).statusCode).toBe(400);
    expect((await post(rule({ pattern: "X", categoryId: 9999 }))).statusCode).toBe(422);
    expect((await post({ pattern: "X" })).statusCode).toBe(400);
    await createRule(rule({ pattern: "X", categoryId: categories.Fuel! }));
    expect((await post(rule({ pattern: "X", categoryId: categories.Groceries! }))).statusCode).toBe(409);
  });

  it("previews what a pattern matches", async () => {
    await addTransaction("SAFEWAY", -10);
    const categorized = await addTransaction("SAFEWAY", -20);
    await addTransaction("COSTCO", -30);
    await app.inject({ method: "PUT", url: `/api/transactions/${categorized}/category`, payload: { categoryId: categories.Groceries } });

    const response = await app.inject({
      method: "POST",
      url: "/api/rules/preview",
      payload: { matchType: "contains", pattern: "safe", direction: "any" },
    });
    const preview = response.json<RulePreview>();
    expect(preview).toMatchObject({ total: 2, uncategorized: 1 });
    expect(preview.examples.map((e) => e.categoryName).sort()).toEqual(["Groceries", null]);
  });

  it.skipIf(!existsSync(SAMPLE))("categorizes newly imported transactions", async () => {
    await truncateAll(pool);
    const data = readFileSync(SAMPLE);
    const statement = await parseUsBankStatement(data, { strict: true });
    const { rows } = await pool.query<{ id: number }>("INSERT INTO categories (name) VALUES ('Groceries') RETURNING id");
    await createRule(rule({ pattern: "GROCERY", categoryId: rows[0]!.id }));

    const first = await importStatement(pool, statement, { name: "a.pdf", data });
    const { rows: counted } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM transactions WHERE category_id IS NOT NULL");
    expect(first.categorized).toBeGreaterThan(0);
    expect(counted[0]!.n).toBe(first.categorized);
    expect((await importStatement(pool, statement, { name: "a.pdf", data })).categorized).toBe(0);
  });
});

describe.skipIf(!testPool)("seeded categories and rules", () => {
  let pool: pg.Pool;

  it("migrates a fresh database with valid starter rules", async () => {
    pool = (await openTestDatabase("kuberaxis_test_fresh"))!;
    const { rows } = await pool.query<{ categories: number; rules: number; orphans: number }>(
      `SELECT (SELECT count(*)::int FROM categories) AS categories, (SELECT count(*)::int FROM category_rules) AS rules`,
    );
    expect(rows[0]!.categories).toBe(36);
    const { rows: kinds } = await pool.query<{ kind: string; names: string[] }>(
      "SELECT kind, array_agg(name ORDER BY name) AS names FROM categories WHERE kind <> 'expense' GROUP BY kind ORDER BY kind",
    );
    expect(kinds).toEqual([
      { kind: "income", names: ["Interest", "Paycheck"] },
      { kind: "transfer", names: ["Credit Card Payment", "Investments", "Transfers"] },
    ]);
    expect(rows[0]!.rules).toBeGreaterThan(150);

    // Compiles every seeded regular expression against a sample of shapes they should and shouldn't match.
    await pool.query("INSERT INTO accounts (bank, name) VALUES ('Test', 'Checking')");
    await pool.query(
      "INSERT INTO imports (file_name, file_sha256, period_start, period_end) VALUES ('t', 'x', '2026-01-01', '2026-01-31')",
    );
    const samples: [string, number, string | null][] = [
      ["MCDONALD'S F1234 ANYTOWN ST", -9.5, "Fast Food"],
      ["SAFEWAY FUEL1234 ANYTOWN", -40, "Fuel"],
      ["SAFEWAY #1234 ANYTOWN", -80, "Groceries"],
      ["To PwP AMAZON PRIME", -14.99, "Software & Subscriptions"],
      ["To PwP AMAZON MKTPL", -30, "Shopping"],
      ["LES SCHWAB TIRES", -200, "Auto Maintenance"],
      ["SHELLFISH SHACK", -30, null],
      ["From EMPLOYER INC PAYROLL", 2000, "Paycheck"],
      ["STARBUCKS CAFE #12", -6, "Coffee"],
      ["MOUNTAIN CAFE", -19, "Restaurants"],
      ["UBER *TRIP HELP.UBER.COM", -25, "Travel"],
    ];
    for (const [description, amount] of samples) {
      await pool.query(
        `INSERT INTO transactions (account_id, import_id, posted_date, section, type, description, amount_cents, fingerprint, occurrence)
         VALUES (1, 1, '2026-01-05', 's', 'Debit Purchase', $1, $2, gen_random_uuid()::text, 1)`,
        [description, Math.round(amount * 100)],
      );
    }
    await applyRules(pool);
    const { rows: result } = await pool.query<{ description: string; name: string | null }>(
      "SELECT t.description, c.name FROM transactions t LEFT JOIN categories c ON c.id = t.category_id ORDER BY t.id",
    );
    expect(result.map((r) => r.name)).toEqual(samples.map(([, , category]) => category));
  });

  afterAll(() => pool?.end());
});
