import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createReceipt, getReceipt, ReceiptError, saveExtraction, validateExtraction } from "../src/receipts.js";
import { buildServer } from "../src/server.js";
import type { ReceiptExtraction, ReceiptExtractionLine } from "../src/types.js";
import { openTestDatabase, truncateAll } from "./testDb.js";

const line = (kind: ReceiptExtractionLine["kind"], description: string, amount: number, extra: Partial<ReceiptExtractionLine> = {}) => ({
  kind,
  description,
  amount,
  quantity: null,
  unit: null,
  unitPrice: null,
  sku: null,
  taxCode: null,
  appliesToIndex: null,
  suggestedCategory: null,
  confidence: null,
  bbox: null,
  ...extra,
});

/** A fictional grocery run: $42.10 paid on one card. */
const groceryRun = (): ReceiptExtraction => ({
  merchant: { name: "MAIN ST GROCERY", address: "100 Main St, Anytown", phone: null },
  purchasedAt: { date: "2026-10-05", time: "14:32" },
  currency: null,
  subtotal: 39.4,
  total: 42.1,
  lines: [
    line("item", "GV 2% MILK GAL", 3.48, { taxCode: "N", suggestedCategory: "Groceries" }),
    line("item", "BANANAS", 1.37, { quantity: 2.04, unit: "lb", unitPrice: 0.67, taxCode: "N", suggestedCategory: "groceries" }),
    line("item", "PAPER TOWELS 6PK", 12.97, { taxCode: "T", suggestedCategory: "Household Supplies" }),
    line("discount", "COUPON PAPER TOWELS", -2, { appliesToIndex: 2 }),
    line("item", "DISH SOAP", 23.58, { taxCode: "T", suggestedCategory: "Not A Category", confidence: 0.62 }),
    line("tax", "TAX 8.1%", 2.7, { taxCode: "T" }),
  ],
  payments: [{ method: "card", cardBrand: "VISA", cardLast4: "4321", amount: 42.1 }],
});

describe("validateExtraction", () => {
  it("passes a receipt whose lines, subtotal and payments add up", () => {
    expect(validateExtraction(groceryRun())).toEqual([]);
  });

  it("reports what doesn't add up", () => {
    const receipt = groceryRun();
    receipt.lines.pop(); // lose the tax line
    receipt.subtotal = 40;
    receipt.payments[0]!.amount = 40;
    receipt.payments[0]!.cardLast4 = "43X1";
    receipt.lines[0]!.appliesToIndex = 1;
    expect(validateExtraction(receipt)).toEqual([
      "Lines add up to $39.40 but the total is $42.10 ($2.70 unaccounted for)",
      "Items add up to $39.40 but the subtotal is $40.00",
      "Payments add up to $40.00 but the total is $42.10",
      "Line 1 points at another line but isn't a discount",
      '"43X1" isn\'t the last four digits of a card',
    ]);
  });

  it("accepts either reading of what the subtotal includes", () => {
    const receipt = groceryRun();
    receipt.lines.splice(5, 0, line("deposit", "BOTTLE DEPOSIT", 0.3));
    receipt.total = 42.4;
    receipt.payments[0]!.amount = 42.4;
    expect(validateExtraction(receipt)).toEqual([]);
    receipt.subtotal = 39.7;
    expect(validateExtraction(receipt)).toEqual([]);
  });
});

const testPool = await openTestDatabase("kuberaxis_test_receipts");
if (!testPool) console.warn("Skipping receipt tests: needs Postgres (npm run db:up)");

describe.skipIf(!testPool)("receipts in the database", () => {
  const pool = testPool!;
  const file = (data = "fake image bytes") => ({ name: "receipt.jpg", contentType: "image/jpeg", data: Buffer.from(data) });
  let transactionId: string;

  beforeEach(async () => {
    await truncateAll(pool);
    await pool.query("INSERT INTO categories (name) VALUES ('Groceries'), ('Household Supplies')");
    const { rows } = await pool.query<{ id: string }>(
      `WITH a AS (INSERT INTO accounts (bank, name) VALUES ('Test', 'Checking') RETURNING id),
            i AS (INSERT INTO imports (file_name, file_sha256, period_start, period_end)
                  VALUES ('t.pdf', 'x', '2026-10-01', '2026-10-31') RETURNING id)
       INSERT INTO transactions (account_id, import_id, posted_date, section, type, description, amount_cents, fingerprint, occurrence)
       SELECT a.id, i.id, '2026-10-06', 'Card Withdrawals', 'Debit Purchase', 'MAIN ST GROCERY', -4500, 'fp', 1 FROM a, i
       RETURNING id::text`,
    );
    transactionId = rows[0]!.id;
  });
  afterAll(() => pool.end());

  it("stores each file once", async () => {
    const first = await createReceipt(pool, file());
    expect(first.created).toBe(true);
    expect(await createReceipt(pool, file())).toEqual({ receiptId: first.receiptId, created: false });
    expect((await createReceipt(pool, file("another photo"))).created).toBe(true);
    expect(await getReceipt(pool, first.receiptId)).toMatchObject({ status: "pending", fileName: "receipt.jpg", lines: [], payments: [] });
  });

  it("saves an extraction: lines, categories by name, discount links and payments", async () => {
    const { receiptId } = await createReceipt(pool, file());
    const receipt = await saveExtraction(pool, receiptId, groceryRun(), { extractor: "test", raw: { provider: "output" } });

    expect(receipt).toMatchObject({
      status: "extracted",
      merchantName: "MAIN ST GROCERY",
      purchaseDate: "2026-10-05",
      purchaseTime: "14:32:00",
      currency: "USD",
      subtotal: 39.4,
      total: 42.1,
      extractor: "test",
      validationIssues: [],
    });
    const categoryNames = await pool.query<{ id: number; name: string }>("SELECT id, name FROM categories");
    const nameOf = new Map(categoryNames.rows.map((c) => [c.id, c.name]));
    expect(receipt.lines.map((l) => [l.position, l.kind, l.amount, l.categoryId && nameOf.get(l.categoryId)])).toEqual([
      [1, "item", 3.48, "Groceries"],
      [2, "item", 1.37, "Groceries"],
      [3, "item", 12.97, "Household Supplies"],
      [4, "discount", -2, null],
      [5, "item", 23.58, null],
      [6, "tax", 2.7, null],
    ]);
    expect(receipt.lines[1]).toMatchObject({ quantity: 2.04, unit: "lb", unitPrice: 0.67 });
    expect(receipt.lines[3]!.appliesToLineId).toBe(receipt.lines[2]!.id);
    expect(receipt.lines[4]!.confidence).toBeCloseTo(0.62);
    expect(receipt.payments).toMatchObject([
      { method: "card", cardLast4: "4321", amount: 42.1, matchStatus: "unmatched", amountDelta: null },
    ]);
    const raw = await pool.query("SELECT raw_extraction FROM receipts WHERE id = $1", [receiptId]);
    expect(raw.rows[0].raw_extraction).toEqual({ provider: "output" });
  });

  it("adds a stand-in payment when none was found, and marks cash as nothing to match", async () => {
    const { receiptId } = await createReceipt(pool, file());
    const noPayment = { ...groceryRun(), payments: [] };
    expect((await saveExtraction(pool, receiptId, noPayment, { extractor: "test" })).payments).toMatchObject([
      { method: "unknown", amount: 42.1, matchStatus: "unmatched" },
    ]);
    const cash = { ...groceryRun(), payments: [{ method: "cash" as const, cardBrand: null, cardLast4: null, amount: 42.1 }] };
    expect((await saveExtraction(pool, receiptId, cash, { extractor: "test" })).payments).toMatchObject([
      { method: "cash", matchStatus: "not_applicable" },
    ]);
  });

  it("re-extracts a receipt, but not one that's reviewed or matched", async () => {
    const { receiptId } = await createReceipt(pool, file());
    await saveExtraction(pool, receiptId, groceryRun(), { extractor: "first" });
    const shorter = { ...groceryRun(), lines: groceryRun().lines.slice(0, 2), total: 4.85, subtotal: null, payments: [] };
    const again = await saveExtraction(pool, receiptId, shorter, { extractor: "second" });
    expect(again).toMatchObject({ extractor: "second", total: 4.85 });
    expect(again.lines).toHaveLength(2);

    await pool.query("UPDATE receipt_payments SET transaction_id = $2, match_status = 'confirmed' WHERE receipt_id = $1", [
      receiptId,
      transactionId,
    ]);
    await expect(saveExtraction(pool, receiptId, groceryRun(), { extractor: "x" })).rejects.toMatchObject({ statusCode: 409 });
    await pool.query("UPDATE receipt_payments SET transaction_id = NULL, match_status = 'unmatched' WHERE receipt_id = $1", [receiptId]);
    await pool.query("UPDATE receipts SET status = 'reviewed' WHERE id = $1", [receiptId]);
    await expect(saveExtraction(pool, receiptId, groceryRun(), { extractor: "x" })).rejects.toBeInstanceOf(ReceiptError);
    await expect(saveExtraction(pool, 9999, groceryRun(), { extractor: "x" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("computes how far a matched transaction is from the receipt", async () => {
    const { receiptId } = await createReceipt(pool, file());
    await saveExtraction(pool, receiptId, groceryRun(), { extractor: "test" });
    await pool.query("UPDATE receipt_payments SET transaction_id = $2, match_status = 'suggested' WHERE receipt_id = $1", [
      receiptId,
      transactionId,
    ]);
    // The card was charged $45.00 for a $42.10 receipt.
    expect((await getReceipt(pool, receiptId))!.payments).toMatchObject([{ transactionId, matchStatus: "suggested", amountDelta: 2.9 }]);
  });

  describe("constraints", () => {
    let receiptId: number;
    let lineIds: string[];
    let paymentId: number;

    beforeEach(async () => {
      receiptId = (await createReceipt(pool, file())).receiptId;
      const receipt = await saveExtraction(pool, receiptId, groceryRun(), { extractor: "test" });
      lineIds = receipt.lines.map((l) => l.id);
      paymentId = receipt.payments[0]!.id;
    });

    it("keeps item discounts on the same receipt, and only on discounts", async () => {
      const other = (await createReceipt(pool, file("other"))).receiptId;
      const { rows } = await pool.query<{ id: string }>(
        "INSERT INTO receipt_lines (receipt_id, position, kind, description, amount_cents) VALUES ($1, 1, 'discount', 'x', -100) RETURNING id",
        [other],
      );
      await expect(pool.query("UPDATE receipt_lines SET applies_to_line_id = $2 WHERE id = $1", [rows[0]!.id, lineIds[0]])).rejects.toThrow(
        /foreign key/,
      );
      await expect(pool.query("UPDATE receipt_lines SET applies_to_line_id = $2 WHERE id = $1", [lineIds[1], lineIds[0]])).rejects.toThrow(
        /check constraint/,
      );
      await expect(pool.query("UPDATE receipt_lines SET kind = 'bogus' WHERE id = $1", [lineIds[0]])).rejects.toThrow(/check constraint/);
    });

    it("ties match status to having a transaction, one payment per transaction", async () => {
      const update = (transaction: string | null, status: string) =>
        pool.query("UPDATE receipt_payments SET transaction_id = $2, match_status = $3 WHERE id = $1", [paymentId, transaction, status]);
      await expect(update(null, "suggested")).rejects.toThrow(/check constraint/);
      await expect(update(transactionId, "unmatched")).rejects.toThrow(/check constraint/);
      await update(transactionId, "confirmed");

      const second = await pool.query<{ id: number }>(
        "INSERT INTO receipt_payments (receipt_id, method, amount_cents) VALUES ($1, 'card', 100) RETURNING id",
        [receiptId],
      );
      await expect(
        pool.query("UPDATE receipt_payments SET transaction_id = $2, match_status = 'suggested' WHERE id = $1", [
          second.rows[0]!.id,
          transactionId,
        ]),
      ).rejects.toThrow(/unique/);
    });

    it("cleans up when a receipt is deleted, keeping items written from it", async () => {
      await pool.query("INSERT INTO receipt_match_rejections (payment_id, transaction_id) VALUES ($1, $2)", [paymentId, transactionId]);
      await pool.query(
        "INSERT INTO transaction_items (transaction_id, position, description, amount_cents, receipt_id) VALUES ($1, 1, 'Groceries', -4500, $2)",
        [transactionId, receiptId],
      );
      await pool.query("DELETE FROM receipts WHERE id = $1", [receiptId]);
      const { rows } = await pool.query(
        `SELECT (SELECT count(*)::int FROM receipt_lines) AS lines, (SELECT count(*)::int FROM receipt_payments) AS payments,
                (SELECT count(*)::int FROM receipt_match_rejections) AS rejections,
                (SELECT count(*)::int FROM transaction_items WHERE receipt_id IS NULL) AS kept_items`,
      );
      expect(rows[0]).toEqual({ lines: 0, payments: 0, rejections: 0, kept_items: 1 });
    });

    it("purges receipts along with transactions, keeping categories", async () => {
      await pool.query("UPDATE receipt_payments SET transaction_id = $2, match_status = 'confirmed' WHERE id = $1", [
        paymentId,
        transactionId,
      ]);
      const app = buildServer({ pool, maxUploadBytes: 1, allowPurge: true, logger: false });
      expect((await app.inject({ method: "DELETE", url: "/api/data" })).json()).toEqual({ ok: true });
      await app.close();
      const { rows } = await pool.query(
        "SELECT (SELECT count(*)::int FROM receipts) + (SELECT count(*)::int FROM receipt_files) AS receipts, (SELECT count(*)::int FROM categories) AS categories",
      );
      expect(rows[0]).toEqual({ receipts: 0, categories: 2 });
    });
  });
});
