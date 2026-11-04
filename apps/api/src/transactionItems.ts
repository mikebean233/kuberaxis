import type pg from "pg";
import type { TransactionItem, TransactionItemInput } from "./types.js";

export class ItemsError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/**
 * Checks a proposed itemization of a transaction and converts its amounts to cents. An empty list
 * is valid (it removes the itemization); otherwise the items must add up to the transaction exactly.
 */
export function validateItems(transactionAmountCents: number, items: TransactionItemInput[]): { cents: number[]; issues: string[] } {
  const issues: string[] = [];
  const cents = items.map((item, i) => {
    const value = item.amount * 100;
    const rounded = Math.round(value);
    if (!Number.isFinite(value) || Math.abs(value - rounded) > 1e-6) issues.push(`Item ${i + 1}: amount must be in whole cents`);
    if (!item.description.trim() && item.categoryId === null) issues.push(`Item ${i + 1}: needs a description or a category`);
    return rounded;
  });

  if (items.length > 0 && issues.length === 0) {
    const total = cents.reduce((a, b) => a + b, 0);
    if (total !== transactionAmountCents) {
      issues.push(
        `Items add up to ${formatCents(total)} but the transaction is ${formatCents(transactionAmountCents)} ` +
          `(${formatCents(transactionAmountCents - total)} unaccounted for)`,
      );
    }
  }
  return { cents, issues };
}

const formatCents = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

const SELECT_ITEMS = `
  SELECT ti.id::text AS id, ti.description, (ti.amount_cents / 100.0)::float8 AS amount,
         ti.category_id AS "categoryId", c.name AS "categoryName"
  FROM transaction_items ti LEFT JOIN categories c ON c.id = ti.category_id
  WHERE ti.transaction_id = $1
  ORDER BY ti.position`;

/** The transaction's items in order, or null when there's no such transaction. */
export async function getTransactionItems(db: pg.Pool | pg.PoolClient, transactionId: string): Promise<TransactionItem[] | null> {
  const { rowCount } = await db.query("SELECT 1 FROM transactions WHERE id = $1", [transactionId]);
  if (!rowCount) return null;
  return (await db.query<TransactionItem>(SELECT_ITEMS, [transactionId])).rows;
}

/** Replaces all of a transaction's items in one database transaction. Throws ItemsError for bad input. */
export async function replaceTransactionItems(
  pool: pg.Pool,
  transactionId: string,
  items: TransactionItemInput[],
): Promise<TransactionItem[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Locking the transaction row serializes concurrent edits of the same transaction's items.
    const { rows } = await client.query<{ amount_cents: string }>("SELECT amount_cents FROM transactions WHERE id = $1 FOR UPDATE", [
      transactionId,
    ]);
    if (!rows[0]) throw new ItemsError("Transaction not found", 404);

    const { cents, issues } = validateItems(Number(rows[0].amount_cents), items);
    const categoryIds = [...new Set(items.flatMap((item) => (item.categoryId === null ? [] : [item.categoryId])))];
    if (categoryIds.length) {
      const found = await client.query<{ id: number }>("SELECT id FROM categories WHERE id = ANY($1::int[])", [categoryIds]);
      const known = new Set(found.rows.map((r) => r.id));
      for (const id of categoryIds) if (!known.has(id)) issues.push(`Category ${id} doesn't exist`);
    }
    if (issues.length) throw new ItemsError("These items don't fit the transaction", 422, issues);

    await client.query("DELETE FROM transaction_items WHERE transaction_id = $1", [transactionId]);
    if (items.length) {
      await client.query(
        `INSERT INTO transaction_items (transaction_id, position, description, amount_cents, category_id)
         SELECT $1, r.position, r.description, r.amount_cents, r.category_id
         FROM jsonb_to_recordset($2::jsonb) AS r(position integer, description text, amount_cents bigint, category_id integer)`,
        [
          transactionId,
          JSON.stringify(
            items.map((item, i) => ({
              position: i + 1,
              description: item.description.trim(),
              amount_cents: cents[i],
              category_id: item.categoryId,
            })),
          ),
        ],
      );
    }

    const saved = (await client.query<TransactionItem>(SELECT_ITEMS, [transactionId])).rows;
    await client.query("COMMIT");
    return saved;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
