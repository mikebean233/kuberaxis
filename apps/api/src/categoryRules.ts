import type pg from "pg";
import type { ApplyRulesResult, CategoryRule, CategoryRuleInput, RulePreview } from "./types.js";

type Db = pg.Pool | pg.PoolClient;

export class RuleError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/** What rules match against: the transaction's type, description and detail lines. */
const MATCH_TEXT = `concat_ws(' ', t.type, t.description, array_to_string(t.details, ' '))`;

/** SQL condition for rule `r` (or a pattern given as $-parameters in the same shape) matching transaction `t`. */
const matches = (matchType: string, pattern: string, direction: string) => `
  (CASE ${matchType} WHEN 'contains' THEN strpos(lower(${MATCH_TEXT}), lower(${pattern})) > 0 ELSE ${MATCH_TEXT} ~* ${pattern} END)
  AND (${direction} = 'any' OR (${direction} = 'debit') = (t.amount_cents < 0))`;

/** Transactions with no category of their own and no items. */
export const UNCATEGORIZED = `t.category_id IS NULL AND NOT EXISTS (SELECT 1 FROM transaction_items ti WHERE ti.transaction_id = t.id)`;

/**
 * Gives each uncategorized transaction the category of the first enabled rule that matches it.
 * With `importId`, only that import's transactions are considered. Returns how many were categorized.
 */
export async function applyRules(db: Db, { importId }: { importId?: number } = {}): Promise<number> {
  const { rowCount } = await db.query(
    `WITH best AS (
       SELECT DISTINCT ON (t.id) t.id, r.id AS rule_id, r.category_id
       FROM transactions t
       JOIN category_rules r ON r.enabled AND ${matches("r.match_type", "r.pattern", "r.direction")}
       WHERE ${UNCATEGORIZED} AND ($1::int IS NULL OR t.import_id = $1)
       ORDER BY t.id, r.priority, r.id
     )
     UPDATE transactions t SET category_id = best.category_id, category_rule_id = best.rule_id
     FROM best WHERE t.id = best.id`,
    [importId ?? null],
  );
  return rowCount ?? 0;
}

/**
 * Applies the rules to every uncategorized transaction. With `reapply`, first clears the categories that
 * rules set earlier, so edited or reordered rules take effect; categories set by hand are kept.
 */
export async function applyRulesToAll(pool: pg.Pool, { reapply = false } = {}): Promise<ApplyRulesResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (reapply) {
      await client.query("UPDATE transactions SET category_id = NULL, category_rule_id = NULL WHERE category_rule_id IS NOT NULL");
    }
    const categorized = await applyRules(client);
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM transactions t WHERE ${UNCATEGORIZED}`);
    await client.query("COMMIT");
    return { categorized, uncategorized: rows[0]!.n };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function previewRule(db: Db, rule: Pick<CategoryRuleInput, "matchType" | "pattern" | "direction">): Promise<RulePreview> {
  await assertValidPattern(db, rule);
  const { rows } = await db.query<RulePreview["examples"][number] & { total: number; uncategorized: number }>(
    `SELECT t.id::text AS id, t.posted_date AS "postedDate", t.description, t.details,
            (t.amount_cents / 100.0)::float8 AS amount, c.name AS "categoryName",
            count(*) OVER ()::int AS total,
            (count(*) FILTER (WHERE ${UNCATEGORIZED}) OVER ())::int AS uncategorized
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE ${matches("$1", "$2", "$3")}
     ORDER BY t.posted_date DESC, t.id DESC
     LIMIT 10`,
    [rule.matchType, rule.pattern, rule.direction],
  );
  return {
    total: rows[0]?.total ?? 0,
    uncategorized: rows[0]?.uncategorized ?? 0,
    examples: rows.map(({ total: _t, uncategorized: _u, ...example }) => example),
  };
}

const SELECT_RULES = `
  SELECT r.id, r.match_type AS "matchType", r.pattern, r.direction, r.category_id AS "categoryId",
         c.name AS "categoryName", r.priority, r.enabled,
         (SELECT count(*)::int FROM transactions t WHERE t.category_rule_id = r.id) AS "matchCount"
  FROM category_rules r JOIN categories c ON c.id = r.category_id`;

export async function listRules(db: Db): Promise<CategoryRule[]> {
  return (await db.query<CategoryRule>(`${SELECT_RULES} ORDER BY r.priority, r.id`)).rows;
}

export async function createRule(db: Db, input: CategoryRuleInput): Promise<CategoryRule> {
  const rule = await checkRule(db, input);
  const { rows } = await saving(() =>
    db.query<{ id: number }>(
      `INSERT INTO category_rules (match_type, pattern, direction, category_id, priority, enabled)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [rule.matchType, rule.pattern, rule.direction, rule.categoryId, rule.priority, rule.enabled],
    ),
  );
  return (await getRule(db, rows[0]!.id))!;
}

export async function updateRule(db: Db, id: number, input: CategoryRuleInput): Promise<CategoryRule> {
  const rule = await checkRule(db, input);
  const { rowCount } = await saving(() =>
    db.query(
      `UPDATE category_rules SET match_type = $2, pattern = $3, direction = $4, category_id = $5, priority = $6, enabled = $7
       WHERE id = $1`,
      [id, rule.matchType, rule.pattern, rule.direction, rule.categoryId, rule.priority, rule.enabled],
    ),
  );
  if (!rowCount) throw new RuleError("Rule not found", 404);
  return (await getRule(db, id))!;
}

/** Deletes a rule. Transactions it categorized keep their category, as if it had been set by hand. */
export async function deleteRule(db: Db, id: number): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM category_rules WHERE id = $1", [id]);
  return Boolean(rowCount);
}

async function getRule(db: Db, id: number): Promise<CategoryRule | undefined> {
  return (await db.query<CategoryRule>(`${SELECT_RULES} WHERE r.id = $1`, [id])).rows[0];
}

async function checkRule(db: Db, input: CategoryRuleInput): Promise<CategoryRuleInput> {
  const rule = { ...input, pattern: input.matchType === "contains" ? input.pattern.trim() : input.pattern };
  await assertValidPattern(db, rule);
  const { rowCount } = await db.query("SELECT 1 FROM categories WHERE id = $1", [rule.categoryId]);
  if (!rowCount) throw new RuleError("That category doesn't exist", 422);
  return rule;
}

/** Rejects empty patterns and regular expressions PostgreSQL can't compile. */
async function assertValidPattern(db: Db, { matchType, pattern }: Pick<CategoryRuleInput, "matchType" | "pattern">) {
  if (!pattern.trim()) throw new RuleError("Enter a pattern to match", 400);
  if (matchType !== "regex") return;
  try {
    await db.query("SELECT '' ~* $1", [pattern]);
  } catch (err) {
    throw new RuleError("That isn't a valid regular expression", 422, [(err as Error).message]);
  }
}

async function saving<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new RuleError("A rule with this pattern and direction already exists", 409);
    throw err;
  }
}
