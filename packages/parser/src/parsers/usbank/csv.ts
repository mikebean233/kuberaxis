import type { Transaction, UsBankStatement } from "./types.js";

const COLUMNS: { header: string; value: (t: Transaction, account: string) => string }[] = [
  { header: "Account", value: (_, account) => account },
  { header: "Date", value: (t) => t.date },
  { header: "Transaction Date", value: (t) => t.transactionDate ?? "" },
  { header: "Section", value: (t) => t.section },
  { header: "Type", value: (t) => t.type },
  { header: "Description", value: (t) => t.description },
  { header: "Details", value: (t) => t.details.join(" | ") },
  { header: "Ref Number", value: (t) => t.refNumber ?? "" },
  { header: "Card", value: (t) => t.cardLast4 ?? "" },
  { header: "Amount", value: (t) => t.amount.toFixed(2) },
];

/** One row per transaction across all accounts, in statement order (RFC 4180, CRLF line endings). */
export function statementToCsv(statement: UsBankStatement): string {
  const rows = [COLUMNS.map((c) => c.header)];
  for (const account of statement.accounts) {
    const accountNumber = account.accountNumber ?? statement.accountNumber ?? "";
    for (const t of account.transactions) rows.push(COLUMNS.map((c) => c.value(t, accountNumber)));
  }
  return rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n") + "\r\n";
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
