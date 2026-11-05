import { createHash } from "node:crypto";
import type pg from "pg";
import type { UsBankStatement } from "@kuberaxis/parser";
import { findOrCreateStatementAccount } from "./accounts.js";
import { applyRules } from "./categoryRules.js";
import { toCents, withOccurrences } from "./fingerprint.js";
import type { AccountImportResult, ImportResult } from "./types.js";

/**
 * Stores a parsed statement, skipping transactions that are already in the database.
 * Runs in a single database transaction, so a failed import leaves nothing behind.
 *
 * Each account in the statement goes to the account with the same bank, number and statement name, or a new one;
 * `accountId` instead puts everything into that account (a CSV, which doesn't say which account it's from).
 */
export async function importStatement(
  pool: pg.Pool,
  statement: UsBankStatement,
  file: { name: string; data: Uint8Array },
  options: { accountId?: number } = {},
): Promise<ImportResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sha256 = createHash("sha256").update(file.data).digest("hex");
    const issues = statement.accounts.flatMap((a) => a.validation.issues.map((issue) => `${a.name}: ${issue}`));
    const {
      rows: [importRow],
    } = await client.query<{ id: number }>(
      `INSERT INTO imports (file_name, file_sha256, period_start, period_end, validation_issues)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [file.name, sha256, statement.period.start, statement.period.end, JSON.stringify(issues)],
    );
    const importId = importRow!.id;

    const accounts: AccountImportResult[] = [];
    for (const account of statement.accounts) {
      const accountNumber = account.accountNumber ?? statement.accountNumber ?? "";
      const { id: accountId, created: accountCreated } =
        options.accountId === undefined
          ? await findOrCreateStatementAccount(client, statement.bank, accountNumber, account.name)
          : { id: await lockAccount(client, options.accountId), created: false };

      const rows = withOccurrences(account.transactions).map(({ transaction: t, fingerprint, occurrence }) => ({
        posted_date: t.date,
        transaction_date: t.transactionDate,
        section: t.section,
        type: t.type,
        description: t.description,
        details: t.details,
        ref_number: t.refNumber,
        card_last4: t.cardLast4,
        amount_cents: toCents(t.amount),
        fingerprint,
        occurrence,
      }));

      // Section isn't part of the fingerprint, so a re-import corrects it if the parser now reads it
      // differently. xmax = 0 only for freshly inserted rows, which tells inserts from updates.
      const { rows: written } = await client.query<{ inserted: boolean }>(
        `INSERT INTO transactions (account_id, import_id, posted_date, transaction_date, section, type, description,
                                   details, ref_number, card_last4, amount_cents, fingerprint, occurrence)
         SELECT $1, $2, r.posted_date, r.transaction_date, r.section, r.type, r.description,
                ARRAY(SELECT jsonb_array_elements_text(r.details)), r.ref_number, r.card_last4,
                r.amount_cents, r.fingerprint, r.occurrence
         FROM jsonb_to_recordset($3::jsonb) AS r(
           posted_date date, transaction_date date, section text, type text, description text, details jsonb,
           ref_number text, card_last4 text, amount_cents bigint, fingerprint text, occurrence integer)
         ON CONFLICT (account_id, fingerprint, occurrence) DO UPDATE SET section = EXCLUDED.section
           WHERE transactions.section IS DISTINCT FROM EXCLUDED.section
         RETURNING (xmax = 0) AS inserted`,
        [accountId, importId, JSON.stringify(rows)],
      );

      const inserted = written.filter((w) => w.inserted).length;
      const {
        rows: [saved],
      } = await client.query<{ name: string; accountNumber: string }>(
        `INSERT INTO import_accounts (import_id, account_id, parsed_count, inserted_count, skipped_count, validation_issues)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (import_id, account_id) DO UPDATE SET
           parsed_count = import_accounts.parsed_count + EXCLUDED.parsed_count,
           inserted_count = import_accounts.inserted_count + EXCLUDED.inserted_count,
           skipped_count = import_accounts.skipped_count + EXCLUDED.skipped_count,
           validation_issues = import_accounts.validation_issues || EXCLUDED.validation_issues
         RETURNING (SELECT name FROM accounts WHERE id = $2) AS name,
                   (SELECT account_number FROM accounts WHERE id = $2) AS "accountNumber"`,
        [importId, accountId, rows.length, inserted, rows.length - inserted, JSON.stringify(account.validation.issues)],
      );
      accounts.push({
        accountId,
        accountCreated,
        accountName: saved!.name,
        accountNumber: saved!.accountNumber,
        parsed: rows.length,
        inserted,
        skipped: rows.length - inserted,
        corrected: written.length - inserted,
        validationIssues: account.validation.issues,
      });
    }

    const parsed = sum(accounts.map((a) => a.parsed));
    const inserted = sum(accounts.map((a) => a.inserted));
    const corrected = sum(accounts.map((a) => a.corrected));
    await client.query("UPDATE imports SET parsed_count = $2, inserted_count = $3, skipped_count = $4 WHERE id = $1", [
      importId,
      parsed,
      inserted,
      parsed - inserted,
    ]);

    // Only this import's rows can be uncategorized new arrivals: re-imported rows keep their original import_id.
    const categorized = await applyRules(client, { importId });

    await client.query("COMMIT");
    return {
      importId,
      fileName: file.name,
      period: statement.period,
      parsed,
      inserted,
      skipped: parsed - inserted,
      corrected,
      categorized,
      accounts,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Locks the account for the import, so it can't be deleted halfway through. */
async function lockAccount(client: pg.PoolClient, id: number): Promise<number> {
  const { rowCount } = await client.query("SELECT 1 FROM accounts WHERE id = $1 FOR SHARE", [id]);
  if (!rowCount) throw new ImportAccountError("That account doesn't exist");
  return id;
}

export class ImportAccountError extends Error {}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
