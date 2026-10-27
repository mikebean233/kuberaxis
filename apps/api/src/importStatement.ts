import { createHash } from "node:crypto";
import type pg from "pg";
import type { UsBankStatement } from "@kuberaxis/parser";
import { toCents, withOccurrences } from "./fingerprint.js";
import type { AccountImportResult, ImportResult } from "./types.js";

/**
 * Stores a parsed statement, skipping transactions that are already in the database.
 * Runs in a single database transaction, so a failed import leaves nothing behind.
 */
export async function importStatement(
  pool: pg.Pool,
  statement: UsBankStatement,
  file: { name: string; data: Uint8Array },
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
      const accountId = await upsertAccount(client, statement.bank, accountNumber, account.name);

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
      accounts.push({
        accountName: account.name,
        accountNumber,
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

    await client.query("COMMIT");
    return { importId, fileName: file.name, period: statement.period, parsed, inserted, skipped: parsed - inserted, corrected, accounts };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function upsertAccount(client: pg.PoolClient, bank: string, accountNumber: string, name: string): Promise<number> {
  // The no-op update makes RETURNING yield the id for existing rows too.
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO accounts (bank, account_number, name) VALUES ($1, $2, $3)
     ON CONFLICT (bank, account_number, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [bank, accountNumber, name],
  );
  return rows[0]!.id;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
