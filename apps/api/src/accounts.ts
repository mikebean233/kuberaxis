import type pg from "pg";
import type { Account, AccountInput, AccountKind } from "./types.js";

type Db = pg.Pool | pg.PoolClient;

export class AccountError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

const SELECT_ACCOUNTS = `
  SELECT a.id, a.name, a.kind, a.bank, a.account_number AS "accountNumber", a.statement_name AS "statementName",
         a.created_at AS "createdAt",
         COALESCE(t.count, 0) AS "transactionCount", t.first_date AS "firstDate", t.last_date AS "lastDate",
         COALESCE(i.count, 0) AS "importCount", i.last_imported_at AS "lastImportedAt"
  FROM accounts a
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS count, to_char(min(posted_date), 'YYYY-MM-DD') AS first_date,
           to_char(max(posted_date), 'YYYY-MM-DD') AS last_date
    FROM transactions WHERE account_id = a.id
  ) t ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS count, max(im.imported_at) AS last_imported_at
    FROM import_accounts ia JOIN imports im ON im.id = ia.import_id WHERE ia.account_id = a.id
  ) i ON true`;

export async function listAccounts(db: Db): Promise<Account[]> {
  const { rows } = await db.query<Account>(`${SELECT_ACCOUNTS} ORDER BY lower(a.name), a.id`);
  return rows;
}

export async function getAccount(db: Db, id: number): Promise<Account | null> {
  const { rows } = await db.query<Account>(`${SELECT_ACCOUNTS} WHERE a.id = $1`, [id]);
  return rows[0] ?? null;
}

export function validateAccount(input: AccountInput): AccountInput {
  const name = input.name.trim();
  if (!name) throw new AccountError("Give the account a name", 400);
  return {
    name,
    kind: input.kind,
    bank: input.bank.trim(),
    accountNumber: input.accountNumber.trim(),
    statementName: input.statementName?.trim() || null,
  };
}

export async function createAccount(db: Db, input: AccountInput): Promise<Account> {
  const a = validateAccount(input);
  const id = await writeAccount(() =>
    db.query<{ id: number }>(
      `INSERT INTO accounts (name, kind, bank, account_number, statement_name) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [a.name, a.kind, a.bank, a.accountNumber, a.statementName],
    ),
  );
  return (await getAccount(db, id!))!;
}

export async function updateAccount(db: Db, id: number, input: AccountInput): Promise<Account> {
  const a = validateAccount(input);
  const updated = await writeAccount(() =>
    db.query<{ id: number }>(
      `UPDATE accounts SET name = $2, kind = $3, bank = $4, account_number = $5, statement_name = $6 WHERE id = $1 RETURNING id`,
      [id, a.name, a.kind, a.bank, a.accountNumber, a.statementName],
    ),
  );
  if (updated === undefined) throw new AccountError("Account not found", 404);
  return (await getAccount(db, id))!;
}

async function writeAccount(write: () => Promise<pg.QueryResult<{ id: number }>>): Promise<number | undefined> {
  try {
    return (await write()).rows[0]?.id;
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    throw new AccountError("Another account already has that bank, account number and statement name", 409);
  }
}

/**
 * Deletes an account. With `moveTo`, its transactions move to that account first (merging the two), except ones
 * the other account already has from an overlapping import, which are dropped. Without it, its transactions are
 * deleted. Receipt payments matched to deleted transactions go back to unmatched.
 */
export async function deleteAccount(pool: pg.Pool, id: number, moveTo: number | null): Promise<{ moved: number; deleted: number }> {
  if (moveTo === id) throw new AccountError("Can't move an account's transactions into itself", 400);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await client.query("SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE", [id])).rowCount) {
      throw new AccountError("Account not found", 404);
    }
    if (moveTo !== null && !(await client.query("SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE", [moveTo])).rowCount) {
      throw new AccountError("The account to move to doesn't exist", 422);
    }

    let moved = 0;
    if (moveTo !== null) {
      const result = await client.query(
        `UPDATE transactions t SET account_id = $2
         WHERE t.account_id = $1
           AND NOT EXISTS (SELECT 1 FROM transactions o
                           WHERE o.account_id = $2 AND o.fingerprint = t.fingerprint AND o.occurrence = t.occurrence)`,
        [id, moveTo],
      );
      moved = result.rowCount ?? 0;
      await client.query(
        `INSERT INTO import_accounts (import_id, account_id, parsed_count, inserted_count, skipped_count, validation_issues)
         SELECT import_id, $2, parsed_count, inserted_count, skipped_count, validation_issues
         FROM import_accounts WHERE account_id = $1
         ON CONFLICT (import_id, account_id) DO UPDATE SET
           parsed_count = import_accounts.parsed_count + EXCLUDED.parsed_count,
           inserted_count = import_accounts.inserted_count + EXCLUDED.inserted_count,
           skipped_count = import_accounts.skipped_count + EXCLUDED.skipped_count`,
        [id, moveTo],
      );
    }

    await client.query(
      `UPDATE receipt_payments SET transaction_id = NULL, match_status = 'unmatched', match_score = NULL, matched_at = NULL
       WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id = $1)`,
      [id],
    );
    const { rowCount: deleted } = await client.query("DELETE FROM transactions WHERE account_id = $1", [id]);
    await client.query("DELETE FROM accounts WHERE id = $1", [id]);
    // Imports that only covered this account have nothing left.
    await client.query("DELETE FROM imports i WHERE NOT EXISTS (SELECT 1 FROM import_accounts ia WHERE ia.import_id = i.id)");
    await client.query("COMMIT");
    return { moved, deleted: deleted ?? 0 };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Guesses the type from a statement's product name, e.g. "U.S. BANK SMARTLY CHECKING". */
export function guessKind(statementName: string): AccountKind {
  if (/CHECKING/i.test(statementName)) return "checking";
  if (/SAVINGS|MONEY MARKET/i.test(statementName)) return "savings";
  if (/CREDIT CARD|VISA/i.test(statementName)) return "credit_card";
  return "other";
}

/**
 * The account a statement section belongs to: the one with the same bank, account number and statement name;
 * else a hand-made account with the same bank and account number (ignoring punctuation) that no statement has
 * claimed yet, which this statement then claims; else a new account named after the statement.
 */
export async function findOrCreateStatementAccount(
  client: pg.PoolClient,
  bank: string,
  accountNumber: string,
  statementName: string,
): Promise<{ id: number; created: boolean }> {
  const exact = await client.query<{ id: number }>(
    "SELECT id FROM accounts WHERE bank = $1 AND account_number = $2 AND statement_name = $3",
    [bank, accountNumber, statementName],
  );
  if (exact.rows[0]) return { id: exact.rows[0].id, created: false };

  if (/\d/.test(accountNumber)) {
    const unclaimed = await client.query<{ id: number }>(
      `SELECT id FROM accounts
       WHERE statement_name IS NULL AND lower(bank) = lower($1)
         AND regexp_replace(account_number, '\\D', '', 'g') = regexp_replace($2, '\\D', '', 'g')`,
      [bank, accountNumber],
    );
    if (unclaimed.rows.length === 1) {
      const id = unclaimed.rows[0]!.id;
      await client.query("UPDATE accounts SET statement_name = $2, bank = $3, account_number = $4 WHERE id = $1", [
        id,
        statementName,
        bank,
        accountNumber,
      ]);
      return { id, created: false };
    }
  }

  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO accounts (bank, account_number, statement_name, name, kind) VALUES ($1, $2, $3, $3, $4) RETURNING id`,
    [bank, accountNumber, statementName, guessKind(statementName)],
  );
  return { id: rows[0]!.id, created: true };
}
