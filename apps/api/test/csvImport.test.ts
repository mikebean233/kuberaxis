import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import type { Account, ApiError, ImportResult } from "../src/types.js";
import { openTestDatabase } from "./testDb.js";

// Fictional rows in the shape of a U.S. Bank credit card download.
const CSV = [
  '"Date","Transaction","Name","Memo","Amount"',
  '"2026-10-21","DEBIT","STARBUCKS STORE 00001","ANYTOWN ST; ; ;","-5.25"',
  '"2026-10-20","DEBIT","STARBUCKS STORE 00001","ANYTOWN ST; ; ;","-5.25"',
  '"2026-10-19","CREDIT","PAYMENT THANK YOU","","250.00"',
  '"2026-10-18","DEBIT","SOMEWHERE LOCAL","","-12.00"',
].join("\r\n");

const testPool = await openTestDatabase("kuberaxis_test_csv");
if (!testPool) console.warn("Skipping CSV import tests: needs Postgres (npm run db:up)");

describe.skipIf(!testPool)("CSV import", () => {
  const pool = testPool!;
  const app = buildServer({ pool, maxUploadBytes: 1_000_000, logger: false });
  let card: Account;

  // Keep the seeded categories and rules; clear everything imported.
  beforeEach(async () => {
    await pool.query(
      `TRUNCATE receipt_match_rejections, receipt_payments, receipt_lines, receipts, receipt_files,
                transaction_items, transactions, import_accounts, imports, accounts RESTART IDENTITY`,
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: { name: "Visa", kind: "credit_card", bank: "U.S. Bank", accountNumber: "" },
    });
    card = res.json<Account>();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /** Posts a multipart form; the account field comes before the file, as the web client sends it. */
  function upload(content: string, accountId: number | undefined, fileName = "card.csv") {
    const boundary = "----kuberaxis-test";
    const parts = [
      ...(accountId === undefined ? [] : [`--${boundary}\r\nContent-Disposition: form-data; name="accountId"\r\n\r\n${accountId}\r\n`]),
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n${content}\r\n`,
      `--${boundary}--\r\n`,
    ];
    return app.inject({
      method: "POST",
      url: "/api/imports",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: parts.join(""),
    });
  }

  it("imports the rows into the chosen account and categorizes them with the rules", async () => {
    const res = await upload(CSV, card.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<ImportResult>()).toMatchObject({
      period: { start: "2026-10-18", end: "2026-10-21" },
      parsed: 4,
      inserted: 4,
      categorized: 3,
      accounts: [{ accountId: card.id, accountCreated: false, accountName: "Visa", validationIssues: [] }],
    });

    const { rows } = await pool.query(
      `SELECT t.description, t.amount_cents::int AS cents, c.name AS category
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id ORDER BY t.posted_date, t.id`,
    );
    expect(rows).toEqual([
      { description: "SOMEWHERE LOCAL", cents: -1200, category: null },
      { description: "PAYMENT THANK YOU", cents: 25000, category: "Credit Card Payment" },
      { description: "STARBUCKS STORE 00001 ANYTOWN ST", cents: -525, category: "Coffee" },
      { description: "STARBUCKS STORE 00001 ANYTOWN ST", cents: -525, category: "Coffee" },
    ]);

    const [account] = (await app.inject({ url: "/api/accounts" })).json<Account[]>();
    expect(account).toMatchObject({ transactionCount: 4, importCount: 1, firstDate: "2026-10-18", lastDate: "2026-10-21" });
  });

  it("skips rows already imported from an overlapping download", async () => {
    await upload(CSV.split("\r\n").slice(0, 3).join("\r\n"), card.id, "first.csv");
    const res = await upload(CSV, card.id, "second.csv");
    expect(res.json<ImportResult>()).toMatchObject({ parsed: 4, inserted: 2, skipped: 2 });
  });

  it("requires an existing account", async () => {
    const none = await upload(CSV, undefined);
    expect(none.statusCode).toBe(400);
    expect(none.json<ApiError>().error).toBe("Choose the account this CSV belongs to");

    const missing = await upload(CSV, 999);
    expect(missing.statusCode).toBe(400);
    expect(await pool.query("SELECT 1 FROM imports")).toMatchObject({ rowCount: 0 });
  });

  it("rejects unreadable rows and files that aren't a U.S. Bank CSV", async () => {
    const bad = await upload('Date,Transaction,Name,Memo,Amount\n2026-10-01,DEBIT,X,,"12.3.4"\n', card.id);
    expect(bad.statusCode).toBe(422);
    expect(bad.json<ApiError>().issues).toEqual(['Row 2: unreadable amount "12.3.4"']);

    const other = await upload("Account,Date,Amount\n1,2026-10-01,5\n", card.id, "other.csv");
    expect(other.statusCode).toBe(415);
    expect(await pool.query("SELECT 1 FROM imports")).toMatchObject({ rowCount: 0 });
  });
});
