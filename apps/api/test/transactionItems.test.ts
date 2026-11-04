import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { validateItems } from "../src/transactionItems.js";
import type { Category, TransactionItem, TransactionRow } from "../src/types.js";
import { openTestDatabase, truncateAll } from "./testDb.js";

const item = (amount: number, description = "thing", categoryId: number | null = null) => ({ description, amount, categoryId });

describe("validateItems", () => {
  it("accepts items that add up to the transaction", () => {
    expect(validateItems(-4210, [item(-30.2), item(-12), item(0.1)])).toEqual({ cents: [-3020, -1200, 10], issues: [] });
  });

  it("accepts no items, which removes the itemization", () => {
    expect(validateItems(-4210, []).issues).toEqual([]);
  });

  it("reports how much is unaccounted for", () => {
    expect(validateItems(-4210, [item(-40)]).issues).toEqual([
      "Items add up to -$40.00 but the transaction is -$42.10 (-$2.10 unaccounted for)",
    ]);
  });

  it("rejects fractional cents and empty items", () => {
    expect(validateItems(-100, [item(-0.995), item(-0.005, "  ")]).issues).toEqual([
      "Item 1: amount must be in whole cents",
      "Item 2: amount must be in whole cents",
      "Item 2: needs a description or a category",
    ]);
  });
});

const testPool = await openTestDatabase("kuberaxis_test_items");
if (!testPool) console.warn("Skipping transaction item tests: needs Postgres (npm run db:up)");

describe.skipIf(!testPool)("transaction items API", () => {
  const pool = testPool!;
  const app = buildServer({ pool, maxUploadBytes: 1, logger: false });
  let transactionId: string;

  beforeEach(async () => {
    await truncateAll(pool);
    const { rows } = await pool.query<{ id: string }>(
      `WITH a AS (INSERT INTO accounts (bank, name) VALUES ('Test', 'Checking') RETURNING id),
            i AS (INSERT INTO imports (file_name, file_sha256, period_start, period_end)
                  VALUES ('t.pdf', 'x', '2026-10-01', '2026-10-31') RETURNING id)
       INSERT INTO transactions (account_id, import_id, posted_date, section, type, description, amount_cents, fingerprint, occurrence)
       SELECT a.id, i.id, '2026-10-05', 'Card Withdrawals', 'Debit Purchase', 'TARGET 1234', -4210, 'fp', 1 FROM a, i
       RETURNING id::text`,
    );
    transactionId = rows[0]!.id;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const createCategory = async (name: string) =>
    (await app.inject({ method: "POST", url: "/api/categories", payload: { name } })).json<Category>();
  const putItems = (items: unknown[], id = transactionId) =>
    app.inject({ method: "PUT", url: `/api/transactions/${id}/items`, payload: { items } });
  const listTransactions = async () => (await app.inject({ method: "GET", url: "/api/transactions" })).json<TransactionRow[]>();

  it("creates categories once, ignoring case", async () => {
    const groceries = await createCategory("Groceries");
    expect(await createCategory("  groceries ")).toEqual(groceries);
    await createCategory("Household");
    const list = (await app.inject({ method: "GET", url: "/api/categories" })).json<Category[]>();
    expect(list.map((c) => c.name)).toEqual(["Groceries", "Household"]);
    expect((await app.inject({ method: "POST", url: "/api/categories", payload: { name: " " } })).statusCode).toBe(400);
  });

  it("sets a category's kind, and rejects duplicate names", async () => {
    const pay = (await app.inject({ method: "POST", url: "/api/categories", payload: { name: "Pay", kind: "income" } })).json<Category>();
    expect(pay.kind).toBe("income");
    const other = await createCategory("Other");
    expect(other.kind).toBe("expense");

    const put = (id: number, payload: object) => app.inject({ method: "PUT", url: `/api/categories/${id}`, payload });
    expect((await put(other.id, { name: "Moves", kind: "transfer" })).json()).toEqual({ id: other.id, name: "Moves", kind: "transfer" });
    expect((await put(other.id, { name: "pay", kind: "transfer" })).statusCode).toBe(409);
    expect((await put(other.id, { name: "Moves", kind: "bogus" })).statusCode).toBe(400);
    expect((await put(9999, { name: "X", kind: "income" })).statusCode).toBe(404);
  });

  it("itemizes a transaction across categories and shows it in the transaction list", async () => {
    const groceries = await createCategory("Groceries");
    const household = await createCategory("Household");

    const response = await putItems([item(-30.1, "Food", groceries.id), item(-10, "Paper towels", household.id), item(-2, "Bag")]);
    expect(response.statusCode).toBe(200);
    expect(response.json<TransactionItem[]>().map(({ id: _, ...rest }) => rest)).toEqual([
      { description: "Food", amount: -30.1, categoryId: groceries.id, categoryName: "Groceries" },
      { description: "Paper towels", amount: -10, categoryId: household.id, categoryName: "Household" },
      { description: "Bag", amount: -2, categoryId: null, categoryName: null },
    ]);

    const fetched = await app.inject({ method: "GET", url: `/api/transactions/${transactionId}/items` });
    expect(fetched.json()).toEqual(response.json());
    expect(await listTransactions()).toMatchObject([
      {
        id: transactionId,
        itemCount: 3,
        categories: ["Groceries", "Household"],
        allocations: [
          { categoryId: groceries.id, amount: -30.1 },
          { categoryId: household.id, amount: -10 },
          { categoryId: null, amount: -2 },
        ],
      },
    ]);
  });

  it("rejects items that don't add up, and leaves the existing items alone", async () => {
    await putItems([item(-42.1)]);
    const response = await putItems([item(-40)]);
    expect(response.statusCode).toBe(422);
    expect(response.json().issues).toEqual(["Items add up to -$40.00 but the transaction is -$42.10 (-$2.10 unaccounted for)"]);
    expect(await listTransactions()).toMatchObject([{ itemCount: 1 }]);
  });

  it("rejects unknown categories and malformed bodies", async () => {
    expect((await putItems([item(-42.1, "x", 999)])).json().issues).toEqual(["Category 999 doesn't exist"]);
    expect((await putItems([{ description: "x", amount: "lots", categoryId: null }])).statusCode).toBe(400);
  });

  it("deletes a category, moving or clearing what used it", async () => {
    const groceries = await createCategory("Groceries");
    const food = await createCategory("Food");
    const household = await createCategory("Household");
    const setWhole = (categoryId: number) =>
      pool.query("UPDATE transactions SET category_id = $2 WHERE id = $1", [transactionId, categoryId]);
    const rule = (pattern: string, categoryId: number) =>
      app.inject({
        method: "POST",
        url: "/api/rules",
        payload: { matchType: "contains", pattern, direction: "any", categoryId, priority: 100, enabled: true },
      });
    const usage = async () => (await app.inject({ method: "GET", url: "/api/categories/usage" })).json();
    const del = (id: number, moveTo?: number) =>
      app.inject({ method: "DELETE", url: `/api/categories/${id}${moveTo ? `?moveTo=${moveTo}` : ""}` });

    await putItems([item(-40, "Food", groceries.id), item(-2.1, "Bag", household.id)]);
    await rule("TARGET", groceries.id);
    expect(await usage()).toEqual({
      [groceries.id]: { transactions: 0, items: 1, rules: 1 },
      [household.id]: { transactions: 0, items: 1, rules: 0 },
    });

    // Moving: items and rules follow the category.
    expect((await del(groceries.id, food.id)).json()).toEqual({ ok: true });
    expect(await usage()).toMatchObject({ [food.id]: { items: 1, rules: 1 } });

    // Clearing: items become uncategorized and rules go.
    expect((await del(food.id)).statusCode).toBe(200);
    expect((await listTransactions())[0]!.allocations.map((a) => a.categoryId)).toEqual([null, household.id]);
    expect((await app.inject({ method: "GET", url: "/api/rules" })).json()).toEqual([]);

    // A whole-transaction category is cleared too.
    await putItems([]);
    await setWhole(household.id);
    await del(household.id);
    expect((await listTransactions())[0]).toMatchObject({ categoryId: null, categoryRuleId: null });

    const other = await createCategory("Other");
    expect((await del(other.id, other.id)).statusCode).toBe(400);
    expect((await del(other.id, 9999)).statusCode).toBe(422);
    expect((await del(9999)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/categories" })).json().map((c: Category) => c.name)).toEqual(["Other"]);
  });

  it("removes the itemization when given no items", async () => {
    await putItems([item(-42.1)]);
    expect((await putItems([])).json()).toEqual([]);
    expect(await listTransactions()).toMatchObject([{ itemCount: 0, categories: [], allocations: [{ categoryId: null, amount: -42.1 }] }]);
  });

  it("returns 404 for transactions that don't exist", async () => {
    expect((await putItems([], "999999")).statusCode).toBe(404);
    expect((await putItems([], "abc")).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/transactions/999999/items" })).statusCode).toBe(404);
  });
});
