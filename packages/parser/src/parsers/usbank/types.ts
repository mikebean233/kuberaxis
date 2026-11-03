/** ISO calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

export interface UsBankStatement {
  bank: "U.S. Bank";
  /** Account number as printed in the statement header (often masked/partial). */
  accountNumber: string | null;
  period: { start: IsoDate; end: IsoDate };
  /** Name and mailing address lines from the first page. */
  customerLines: string[];
  accounts: UsBankAccount[];
}

export interface UsBankAccount {
  /** Product name, e.g. "U.S. BANK SMARTLY CHECKING". */
  name: string;
  accountNumber: string | null;
  summary: AccountSummary;
  /** All transactions in statement order. Debits are negative, credits positive. */
  transactions: Transaction[];
  /** "Total ..." lines printed at the end of each section, keyed by section name. */
  sectionTotals: Record<string, number>;
  /** End-of-day balances from the Balance Summary table (only days with activity). */
  dailyBalances: DailyBalance[];
  validation: ValidationResult;
}

export interface AccountSummary {
  beginningBalance: number | null;
  endingBalance: number | null;
  daysInPeriod: number | null;
  averageBalance: number | null;
  /**
   * Label/value pairs from the left column of the Account Summary box (balances and
   * per-section totals), verbatim. Values printed with a trailing "-" are negative
   * (e.g. "Card Withdrawals" -> -2498.69).
   */
  lines: { label: string; value: number }[];
  /**
   * Informational label/value pairs from the right column, e.g. "Number of Days in
   * Statement Period", "Average Account Balance", "Interest Earned this Period".
   */
  details: { label: string; value: number }[];
}

export interface Transaction {
  /** Posting date. */
  date: IsoDate;
  /** Section the transaction was listed under, e.g. "Deposits / Credits", "Card Withdrawals". */
  section: string;
  /** Transaction type column, e.g. "Electronic Deposit", "Debit Purchase - VISA". */
  type: string;
  /** Description column of the first line, e.g. "From Employer INC". */
  description: string;
  /** Indented lines printed beneath the first line. */
  details: string[];
  /** "Ref Number" column, when present. */
  refNumber: string | null;
  /** Signed amount in dollars; withdrawals are negative. */
  amount: number;
  /** Date the card was used ("On MMDDYY"), for card transactions. */
  transactionDate: IsoDate | null;
  /** Last four digits of the card, for transactions listed under a "Card Number:" heading. */
  cardLast4: string | null;
  page: number;
}

export interface DailyBalance {
  date: IsoDate;
  balance: number;
}

export interface ValidationResult {
  ok: boolean;
  issues: string[];
}
