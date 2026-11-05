import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseUsBankStatement, type UsBankStatement } from "@kuberaxis/parser";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importStatement } from "../src/importStatement.js";
import { buildServer } from "../src/server.js";
import type { Account, AccountInput, ApiError, TransactionRow } from "../src/types.js";
import { openTestDatabase, truncateAll } from "./testDb.js";

// Fictional statement: a checking account with 51 transactions and a savings account with 3.
const SAMPLE = fileURLToPath(new URL("../../../test-data/usbank-sample-statement.pdf", import.meta.url));
const testPool = existsSync(SAMPLE) ? await openTestDatabase("kuberaxis_test_accounts") : null;
if (!testPool) console.warn("Skipping account tests: needs Postgres (npm run db:up)");

describe.skipIf(!testPool)("accounts", () => {
  const pool = testPool!;
  const app = buildServer({ pool, maxUploadBytes: 1, logger: false });
  let statement: UsBankStatement;
  let data: Uint8Array;

  beforeAll(async () => {
    data = readFileSync(SAMPLE);
    statement = await parseUsBankStatement(data, { strict: true });
  });
  beforeEach(() => truncateAll(pool));
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const list = async () => (await app.inject({ url: "/api/accounts" })).json<Account[]>();
  const create = (input: AccountInput) => app.inject({ method: "POST", url: "/api/accounts", payload: input });
  const update = (id: number, input: AccountInput) => app.inject({ method: "PUT", url: `/api/accounts/${id}`, payload: input });
  const toInput = ({ name, kind, bank, accountNumber, statementName }: Account): AccountInput => ({
    name,
    kind,
    bank,
    accountNumber,
    statementName,
  });

  it("creates an account per statement account on the first PDF import, and reuses them after", async () => {
    const first = await importStatement(pool, statement, { name: "a.pdf", data });
    expect(first.accounts.map((a) => a.accountCreated)).toEqual([true, true]);

    const accounts = await list();
    expect(accounts).toHaveLength(2);
    const checking = accounts.find((a) => a.kind === "checking")!;
    expect(checking).toMatchObject({ bank: "U.S. Bank", transactionCount: 51, importCount: 1 });
    expect(checking.name).toBe(checking.statementName);
    expect(accounts.find((a) => a.kind === "savings")).toMatchObject({ transactionCount: 3 });

    // Renaming doesn't stop the next import from finding it.
    expect((await update(checking.id, { ...toInput(checking), name: "Everyday checking" })).statusCode).toBe(200);
    const again = await importStatement(pool, statement, { name: "b.pdf", data });
    expect(again.accounts.map((a) => [a.accountCreated, a.accountName])).toContainEqual([false, "Everyday checking"]);
    expect(await list()).toHaveLength(2);
    expect((await list()).find((a) => a.id === checking.id)).toMatchObject({ importCount: 2 });

    const transactions = (await app.inject({ url: "/api/transactions" })).json<TransactionRow[]>();
    expect(transactions.filter((t) => t.accountName === "Everyday checking")).toHaveLength(51);
  });

  it("lets a PDF claim a hand-made account with the same account number", async () => {
    const [checking] = statement.accounts;
    const number = checking!.accountNumber ?? statement.accountNumber!;
    // Typed without the dashes the statement prints.
    const made = (await create({ name: "Joint checking", kind: "checking", bank: "U.S. Bank", accountNumber: number.replace(/\D/g, "") })).json<Account>();
    expect(made.statementName).toBeNull();

    const result = await importStatement(pool, statement, { name: "a.pdf", data });
    expect(result.accounts[0]).toMatchObject({ accountId: made.id, accountCreated: false, accountName: "Joint checking" });
    expect((await list()).find((a) => a.id === made.id)).toMatchObject({ statementName: checking!.name, accountNumber: number });
  });

  it("validates input and refuses duplicate statement identities", async () => {
    expect((await create({ name: "  ", kind: "other", bank: "", accountNumber: "" })).json<ApiError>().error).toBe("Give the account a name");
    expect((await create({ name: "X", kind: "bogus" as never, bank: "", accountNumber: "" })).statusCode).toBe(400);
    const input = { name: "A", kind: "checking", bank: "B", accountNumber: "1", statementName: "S" } as const;
    expect((await create(input)).statusCode).toBe(200);
    expect((await create({ ...input, name: "Other" })).statusCode).toBe(409);
    expect((await update(999, input)).statusCode).toBe(404);
  });

  it("deletes an account with its transactions, or merges them into another", async () => {
    await importStatement(pool, statement, { name: "a.pdf", data });
    const [checking, savings] = [...(await list())].sort((a, b) => b.transactionCount - a.transactionCount);

    // Merge savings into checking: its 3 transactions move, and the import is now recorded against checking.
    const merged = await app.inject({ method: "DELETE", url: `/api/accounts/${savings!.id}?moveTo=${checking!.id}` });
    expect(merged.json()).toEqual({ moved: 3, deleted: 0 });
    expect(await list()).toMatchObject([{ id: checking!.id, transactionCount: 54, importCount: 1 }]);

    const deleted = await app.inject({ method: "DELETE", url: `/api/accounts/${checking!.id}` });
    expect(deleted.json()).toEqual({ moved: 0, deleted: 54 });
    const { rows } = await pool.query("SELECT (SELECT count(*) FROM transactions) + (SELECT count(*) FROM imports) AS n");
    expect(Number(rows[0].n)).toBe(0);

    expect((await app.inject({ method: "DELETE", url: "/api/accounts/999" })).statusCode).toBe(404);
  });

  it("drops transactions the target account already has when merging overlapping accounts", async () => {
    await importStatement(pool, statement, { name: "a.pdf", data });
    const copy = (await create({ name: "Copy", kind: "checking", bank: "", accountNumber: "" })).json<Account>();
    const [checking] = statement.accounts;
    await importStatement(pool, { ...statement, accounts: [checking!] }, { name: "csv-ish", data }, { accountId: copy.id });
    const original = (await list()).find((a) => a.kind === "checking" && a.id !== copy.id)!;

    const merged = await app.inject({ method: "DELETE", url: `/api/accounts/${copy.id}?moveTo=${original.id}` });
    expect(merged.json()).toEqual({ moved: 0, deleted: 51 });
    expect((await list()).find((a) => a.id === original.id)).toMatchObject({ transactionCount: 51 });
  });
});
