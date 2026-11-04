import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseUsBankStatement, type UsBankStatement } from "@kuberaxis/parser";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importStatement } from "../src/importStatement.js";
import { buildServer } from "../src/server.js";
import { openTestDatabase, truncateAll } from "./testDb.js";

// Fictional statement: a checking account with 51 transactions and a savings account with 3.
const SAMPLE = fileURLToPath(new URL("../../../test-data/usbank-sample-statement.pdf", import.meta.url));
const TOTAL = 54;
const testPool = existsSync(SAMPLE) ? await openTestDatabase("kuberaxis_test") : null;
if (!testPool) console.warn("Skipping import tests: needs Postgres (npm run db:up)");

describe.skipIf(!testPool)("importStatement", () => {
  const pool = testPool!;
  let statement: UsBankStatement;
  let data: Uint8Array;

  beforeAll(async () => {
    data = readFileSync(SAMPLE);
    statement = await parseUsBankStatement(data, { strict: true });
  });
  beforeEach(() => truncateAll(pool));
  afterAll(() => pool.end());

  const count = async () => Number((await pool.query("SELECT count(*) FROM transactions")).rows[0].count);

  it("inserts every transaction on first import", async () => {
    const result = await importStatement(pool, statement, { name: "a.pdf", data });
    expect(result).toMatchObject({ parsed: TOTAL, inserted: TOTAL, skipped: 0 });
    expect(await count()).toBe(TOTAL);
  });

  it("skips everything when the same statement is imported again", async () => {
    await importStatement(pool, statement, { name: "a.pdf", data });
    const again = await importStatement(pool, statement, { name: "a-copy.pdf", data });
    expect(again).toMatchObject({ parsed: TOTAL, inserted: 0, skipped: TOTAL });
    expect(await count()).toBe(TOTAL);
  });

  it("only inserts the new transactions from an overlapping statement", async () => {
    const [account] = statement.accounts;
    const firstHalf = account!.transactions.slice(0, 30);
    const partial: UsBankStatement = { ...statement, accounts: [{ ...account!, transactions: firstHalf }] };

    await importStatement(pool, partial, { name: "partial.pdf", data });
    const full = await importStatement(pool, statement, { name: "full.pdf", data });
    expect(full).toMatchObject({ inserted: TOTAL - 30, skipped: 30 });
    expect(await count()).toBe(TOTAL);
  });

  it("corrects the section of already-imported transactions on re-import", async () => {
    const [account, ...others] = statement.accounts;
    const misparsed: UsBankStatement = {
      ...statement,
      accounts: [{ ...account!, transactions: account!.transactions.map((t, i) => (i === 0 ? { ...t, section: "bogus" } : t)) }, ...others],
    };
    await importStatement(pool, misparsed, { name: "a.pdf", data });

    expect(await importStatement(pool, statement, { name: "a.pdf", data })).toMatchObject({ inserted: 0, skipped: TOTAL, corrected: 1 });
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM transactions WHERE section = 'bogus'");
    expect(rows[0].n).toBe(0);
    expect(await importStatement(pool, statement, { name: "a.pdf", data })).toMatchObject({ corrected: 0 });
  });

  it("purges all data through DELETE /api/data only when allowed", async () => {
    await importStatement(pool, statement, { name: "a.pdf", data });

    const locked = buildServer({ pool, maxUploadBytes: 1, logger: false });
    expect((await locked.inject({ method: "DELETE", url: "/api/data" })).statusCode).toBe(404);
    expect(await count()).toBe(TOTAL);

    const app = buildServer({ pool, maxUploadBytes: 1, allowPurge: true, logger: false });
    expect((await app.inject({ method: "DELETE", url: "/api/data" })).json()).toEqual({ ok: true });
    const { rows } = await pool.query(
      "SELECT (SELECT count(*) FROM transactions) + (SELECT count(*) FROM imports) + (SELECT count(*) FROM accounts) AS n",
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("keeps genuinely identical transactions within a statement", async () => {
    const [account] = statement.accounts;
    const t = account!.transactions[0]!;
    const twice: UsBankStatement = { ...statement, accounts: [{ ...account!, transactions: [t, { ...t }] }] };

    expect(await importStatement(pool, twice, { name: "x.pdf", data })).toMatchObject({ inserted: 2 });
    expect(await importStatement(pool, twice, { name: "x.pdf", data })).toMatchObject({ inserted: 0, skipped: 2 });
  });
});
