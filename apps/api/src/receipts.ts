import { createHash } from "node:crypto";
import type pg from "pg";
import { toCents } from "./fingerprint.js";
import type { Receipt, ReceiptExtraction, ReceiptLine, ReceiptPayment } from "./types.js";

type Db = pg.Pool | pg.PoolClient;

export class ReceiptError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

const formatCents = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/**
 * Checks an extraction's arithmetic: the lines should add up to the total, the items to the subtotal and
 * the payments to the total. Returns what doesn't add up; an empty list means it all checks out. These are
 * warnings for review, not reasons to reject the receipt, since extraction is imperfect.
 */
export function validateExtraction(extraction: ReceiptExtraction): string[] {
  const issues: string[] = [];
  const lines = extraction.lines.map((line) => ({ ...line, cents: toCents(line.amount) }));
  const linesTotal = sum(lines.map((l) => l.cents));

  if (extraction.total === null) {
    issues.push("No total was found");
  } else if (linesTotal !== toCents(extraction.total)) {
    const total = toCents(extraction.total);
    issues.push(
      `Lines add up to ${formatCents(linesTotal)} but the total is ${formatCents(total)} (${formatCents(total - linesTotal)} unaccounted for)`,
    );
  }

  if (extraction.subtotal !== null) {
    // Receipts disagree on whether fees and deposits come before the subtotal, so either reading passes.
    const subtotal = toCents(extraction.subtotal);
    const goods = sum(lines.filter((l) => l.kind === "item" || l.kind === "discount").map((l) => l.cents));
    const beforeTax = sum(lines.filter((l) => l.kind !== "tax" && l.kind !== "tip").map((l) => l.cents));
    if (goods !== subtotal && beforeTax !== subtotal) {
      issues.push(`Items add up to ${formatCents(goods)} but the subtotal is ${formatCents(subtotal)}`);
    }
  }

  if (extraction.payments.length && extraction.total !== null) {
    const paid = sum(extraction.payments.map((p) => toCents(p.amount)));
    if (paid !== toCents(extraction.total))
      issues.push(`Payments add up to ${formatCents(paid)} but the total is ${formatCents(toCents(extraction.total))}`);
  }

  lines.forEach((line, i) => {
    if (line.appliesToIndex === null) return;
    const target = lines[line.appliesToIndex];
    if (line.kind !== "discount") issues.push(`Line ${i + 1} points at another line but isn't a discount`);
    else if (!target || target.kind !== "item" || line.appliesToIndex === i)
      issues.push(`Line ${i + 1} is a discount on a line that isn't an item`);
  });
  for (const payment of extraction.payments) {
    if (payment.cardLast4 !== null && !/^[0-9]{4}$/.test(payment.cardLast4))
      issues.push(`"${payment.cardLast4}" isn't the last four digits of a card`);
  }
  return issues;
}

/**
 * Stores an uploaded receipt file and creates a pending receipt for it. Uploading a file that's already
 * stored returns its existing receipt instead.
 */
export async function createReceipt(
  pool: pg.Pool,
  file: { name: string; contentType: string; data: Uint8Array },
): Promise<{ receiptId: number; created: boolean }> {
  const sha256 = createHash("sha256").update(file.data).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO receipt_files (sha256, content_type, file_name, byte_size, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sha256) DO NOTHING RETURNING id`,
      [sha256, file.contentType, file.name, file.data.byteLength, file.data],
    );
    let created = false;
    let receiptId: number;
    if (inserted.rows[0]) {
      const { rows } = await client.query<{ id: number }>("INSERT INTO receipts (file_id) VALUES ($1) RETURNING id", [inserted.rows[0].id]);
      receiptId = rows[0]!.id;
      created = true;
    } else {
      const { rows } = await client.query<{ id: number }>(
        "SELECT r.id FROM receipts r JOIN receipt_files f ON f.id = r.file_id WHERE f.sha256 = $1 ORDER BY r.id LIMIT 1",
        [sha256],
      );
      if (rows[0]) {
        receiptId = rows[0].id;
      } else {
        // The file outlived its receipt; start a new one for it.
        const file = await client.query<{ id: number }>("SELECT id FROM receipt_files WHERE sha256 = $1", [sha256]);
        receiptId = (await client.query<{ id: number }>("INSERT INTO receipts (file_id) VALUES ($1) RETURNING id", [file.rows[0]!.id]))
          .rows[0]!.id;
        created = true;
      }
    }
    await client.query("COMMIT");
    return { receiptId, created };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Writes an extraction into a receipt, replacing any lines and payments read before, and marks it extracted
 * with whatever validateExtraction found. A receipt with no payment found gets one 'unknown' payment for its
 * total, so there's still something to match against a transaction.
 *
 * Refuses receipts the user has reviewed or matched to a transaction, since that would discard their work.
 */
export async function saveExtraction(
  pool: pg.Pool,
  receiptId: number,
  extraction: ReceiptExtraction,
  source: { extractor: string; extractorVersion?: string | null; raw?: unknown },
): Promise<Receipt> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string }>("SELECT status FROM receipts WHERE id = $1 FOR UPDATE", [receiptId]);
    if (!rows[0]) throw new ReceiptError("Receipt not found", 404);
    if (rows[0].status === "reviewed")
      throw new ReceiptError("This receipt has been reviewed; re-extracting it would discard your edits", 409);
    const confirmed = await client.query("SELECT 1 FROM receipt_payments WHERE receipt_id = $1 AND match_status = 'confirmed'", [
      receiptId,
    ]);
    if (confirmed.rowCount) throw new ReceiptError("This receipt is matched to a transaction; unmatch it before re-extracting", 409);

    const issues = validateExtraction(extraction);
    const { merchant, purchasedAt } = extraction;
    await client.query(
      `UPDATE receipts SET status = 'extracted', merchant_name = $2, merchant_address = $3, merchant_phone = $4,
              purchase_date = $5, purchase_time = $6, currency = $7, subtotal_cents = $8, total_cents = $9,
              extractor = $10, extractor_version = $11, raw_extraction = $12, validation_issues = $13, updated_at = now()
       WHERE id = $1`,
      [
        receiptId,
        merchant.name,
        merchant.address,
        merchant.phone,
        purchasedAt.date,
        purchasedAt.time,
        extraction.currency ?? "USD",
        extraction.subtotal === null ? null : toCents(extraction.subtotal),
        extraction.total === null ? null : toCents(extraction.total),
        source.extractor,
        source.extractorVersion ?? null,
        JSON.stringify(source.raw ?? extraction),
        JSON.stringify(issues),
      ],
    );

    await client.query("DELETE FROM receipt_lines WHERE receipt_id = $1", [receiptId]);
    await client.query("DELETE FROM receipt_payments WHERE receipt_id = $1", [receiptId]);

    // Suggested categories are matched to existing ones by name; unknown names are left for review.
    const { rows: inserted } = await client.query<{ id: string; position: number }>(
      `INSERT INTO receipt_lines (receipt_id, position, kind, description, quantity, unit, unit_price_cents, amount_cents,
                                  sku, tax_code, category_id, confidence, bbox)
       SELECT $1, r.position, r.kind, r.description, r.quantity, r.unit, r.unit_price_cents, r.amount_cents,
              r.sku, r.tax_code, (SELECT id FROM categories WHERE lower(name) = lower(r.suggested_category)), r.confidence, r.bbox
       FROM jsonb_to_recordset($2::jsonb) AS r(position integer, kind text, description text, quantity numeric, unit text,
            unit_price_cents numeric, amount_cents bigint, sku text, tax_code text, suggested_category text,
            confidence real, bbox jsonb)
       RETURNING id::text, position`,
      [
        receiptId,
        JSON.stringify(
          extraction.lines.map((line, i) => ({
            position: i + 1,
            kind: line.kind,
            description: line.description,
            quantity: line.quantity,
            unit: line.unit,
            unit_price_cents: line.unitPrice === null ? null : Math.round(line.unitPrice * 100_000) / 1000,
            amount_cents: toCents(line.amount),
            sku: line.sku,
            tax_code: line.taxCode,
            suggested_category: line.suggestedCategory,
            confidence: line.confidence,
            bbox: line.bbox,
          })),
        ),
      ],
    );

    // Link item-level discounts now that the lines have ids. Links validateExtraction flagged are skipped.
    const idAt = new Map(inserted.map((r) => [r.position, r.id]));
    for (const [i, line] of extraction.lines.entries()) {
      const target = line.appliesToIndex === null ? undefined : extraction.lines[line.appliesToIndex];
      if (line.kind !== "discount" || target?.kind !== "item" || line.appliesToIndex === i) continue;
      await client.query("UPDATE receipt_lines SET applies_to_line_id = $2 WHERE id = $1", [
        idAt.get(i + 1),
        idAt.get(line.appliesToIndex! + 1),
      ]);
    }

    const payments = extraction.payments.length
      ? extraction.payments
      : extraction.total === null
        ? []
        : [{ method: "unknown" as const, cardBrand: null, cardLast4: null, amount: extraction.total }];
    for (const p of payments) {
      await client.query(
        `INSERT INTO receipt_payments (receipt_id, method, card_brand, card_last4, amount_cents, match_status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          receiptId,
          p.method,
          p.cardBrand,
          p.cardLast4 !== null && /^[0-9]{4}$/.test(p.cardLast4) ? p.cardLast4 : null,
          toCents(p.amount),
          p.method === "cash" ? "not_applicable" : "unmatched",
        ],
      );
    }

    const receipt = (await getReceipt(client, receiptId))!;
    await client.query("COMMIT");
    return receipt;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** A receipt with its lines (in printed order) and payments, or null when there's no such receipt. */
export async function getReceipt(db: Db, receiptId: number): Promise<Receipt | null> {
  const { rows } = await db.query<Omit<Receipt, "lines" | "payments">>(
    `SELECT r.id, r.file_id AS "fileId", f.file_name AS "fileName", f.content_type AS "contentType", r.status,
            r.merchant_name AS "merchantName", r.merchant_address AS "merchantAddress", r.merchant_phone AS "merchantPhone",
            r.purchase_date AS "purchaseDate", r.purchase_time::text AS "purchaseTime", r.currency,
            (r.subtotal_cents / 100.0)::float8 AS subtotal, (r.total_cents / 100.0)::float8 AS total,
            r.default_category_id AS "defaultCategoryId", r.extractor, r.extractor_version AS "extractorVersion",
            r.validation_issues AS "validationIssues", r.notes
     FROM receipts r JOIN receipt_files f ON f.id = r.file_id
     WHERE r.id = $1`,
    [receiptId],
  );
  if (!rows[0]) return null;

  const lines = await db.query<ReceiptLine>(
    `SELECT id::text, position, kind, description, display_name AS "displayName", quantity::float8 AS quantity, unit,
            (unit_price_cents / 100.0)::float8 AS "unitPrice", (amount_cents / 100.0)::float8 AS amount, sku,
            tax_code AS "taxCode", applies_to_line_id::text AS "appliesToLineId", category_id AS "categoryId",
            confidence, bbox
     FROM receipt_lines WHERE receipt_id = $1 ORDER BY position`,
    [receiptId],
  );
  const payments = await db.query<ReceiptPayment>(
    `SELECT p.id, p.method, p.card_brand AS "cardBrand", p.card_last4 AS "cardLast4",
            (p.amount_cents / 100.0)::float8 AS amount, p.transaction_id::text AS "transactionId",
            p.match_status AS "matchStatus", p.match_score AS "matchScore",
            (m.amount_delta_cents / 100.0)::float8 AS "amountDelta"
     FROM receipt_payments p LEFT JOIN receipt_payment_matches m ON m.payment_id = p.id
     WHERE p.receipt_id = $1 ORDER BY p.id`,
    [receiptId],
  );
  return { ...rows[0], lines: lines.rows, payments: payments.rows };
}
