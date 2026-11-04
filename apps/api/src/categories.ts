import type pg from "pg";
import type { CategoryUsage } from "./types.js";

export class CategoryError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** How many transactions, items and rules use each category, keyed by category id. Unused ones are left out. */
export async function categoryUsage(db: pg.Pool): Promise<Record<number, CategoryUsage>> {
  const { rows } = await db.query<CategoryUsage & { id: number }>(
    `SELECT c.id,
            (SELECT count(*)::int FROM transactions t WHERE t.category_id = c.id
               AND NOT EXISTS (SELECT 1 FROM transaction_items ti WHERE ti.transaction_id = t.id)) AS transactions,
            (SELECT count(*)::int FROM transaction_items ti WHERE ti.category_id = c.id) AS items,
            (SELECT count(*)::int FROM category_rules r WHERE r.category_id = c.id) AS rules
     FROM categories c`,
  );
  return Object.fromEntries(rows.filter((r) => r.transactions + r.items + r.rules > 0).map(({ id, ...usage }) => [id, usage]));
}

/**
 * Deletes a category. With `moveTo`, its transactions, items and rules move to that category first; without
 * it, transactions and items become uncategorized and its rules are deleted.
 */
export async function deleteCategory(pool: pg.Pool, id: number, moveTo: number | null): Promise<void> {
  if (moveTo === id) throw new CategoryError("Can't move a category's transactions into itself", 400);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query("SELECT 1 FROM categories WHERE id = $1 FOR UPDATE", [id]);
    if (!rowCount) throw new CategoryError("Category not found", 404);
    if (moveTo !== null && !(await client.query("SELECT 1 FROM categories WHERE id = $1", [moveTo])).rowCount) {
      throw new CategoryError("The category to move to doesn't exist", 422);
    }

    if (moveTo === null) {
      // Rule-set categories are cleared along with the rule, so the transactions read as uncategorized.
      await client.query("UPDATE transactions SET category_id = NULL, category_rule_id = NULL WHERE category_id = $1", [id]);
      await client.query("UPDATE transaction_items SET category_id = NULL WHERE category_id = $1", [id]);
      await client.query("DELETE FROM category_rules WHERE category_id = $1", [id]);
    } else {
      await client.query("UPDATE transactions SET category_id = $2 WHERE category_id = $1", [id, moveTo]);
      await client.query("UPDATE transaction_items SET category_id = $2 WHERE category_id = $1", [id, moveTo]);
      await client.query("UPDATE category_rules SET category_id = $2 WHERE category_id = $1", [id, moveTo]);
    }
    await client.query("DELETE FROM categories WHERE id = $1", [id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
