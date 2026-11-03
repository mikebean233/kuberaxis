/** API payloads shared with the web app. Amounts are in dollars; debits are negative. */

export interface TransactionRow {
  id: string;
  accountId: number;
  accountName: string;
  accountNumber: string;
  postedDate: string;
  transactionDate: string | null;
  section: string;
  type: string;
  description: string;
  details: string[];
  refNumber: string | null;
  cardLast4: string | null;
  amount: number;
  importId: number;
}

export interface AccountImportResult {
  accountName: string;
  accountNumber: string;
  parsed: number;
  inserted: number;
  skipped: number;
  /** Already-imported transactions (counted in `skipped`) whose section this import corrected. */
  corrected: number;
  validationIssues: string[];
}

export interface ImportResult {
  importId: number;
  fileName: string;
  period: { start: string; end: string };
  parsed: number;
  inserted: number;
  skipped: number;
  corrected: number;
  accounts: AccountImportResult[];
}

export interface ApiError {
  error: string;
  issues?: string[];
}
