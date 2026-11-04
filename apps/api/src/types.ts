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
  /** Number of items the transaction is broken into; 0 when it isn't itemized. */
  itemCount: number;
  /** Distinct category names of its items, sorted. */
  categories: string[];
  /** Category of the transaction as a whole; ignored when it's itemized. */
  categoryId: number | null;
  categoryName: string | null;
  /** The rule that set categoryId, or null when it was set by hand. */
  categoryRuleId: number | null;
  /**
   * Where the amount goes: one entry per item when itemized, otherwise the whole amount in the transaction's
   * category. Amounts are signed like `amount` and add up to it.
   */
  allocations: Allocation[];
}

export interface Allocation {
  categoryId: number | null;
  amount: number;
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
  /** New transactions that a category rule matched. */
  categorized: number;
  accounts: AccountImportResult[];
}

export interface ApiError {
  error: string;
  issues?: string[];
}

/**
 * How money in a category counts: spending (a refund in it reduces spending), income, or a transfer between
 * your own accounts, which counts as neither.
 */
export type CategoryKind = "expense" | "income" | "transfer";

export interface Category {
  id: number;
  name: string;
  kind: CategoryKind;
}

/** What uses a category. `transactions` counts whole (not itemized) transactions in it. */
export interface CategoryUsage {
  transactions: number;
  items: number;
  rules: number;
}

/** One line of an itemized transaction. Amounts follow the transaction's sign: a purchase's items are negative. */
export interface TransactionItem {
  id: string;
  description: string;
  amount: number;
  categoryId: number | null;
  categoryName: string | null;
}

export interface TransactionItemInput {
  description: string;
  amount: number;
  categoryId: number | null;
}

export type RuleMatchType = "contains" | "regex";
export type RuleDirection = "any" | "debit" | "credit";

/** Categorizes matching uncategorized transactions; the first enabled rule by (priority, id) wins. */
export interface CategoryRule {
  id: number;
  matchType: RuleMatchType;
  pattern: string;
  direction: RuleDirection;
  categoryId: number;
  categoryName: string;
  priority: number;
  enabled: boolean;
  /** Transactions currently categorized by this rule. */
  matchCount: number;
}

export type CategoryRuleInput = Pick<CategoryRule, "matchType" | "pattern" | "direction" | "categoryId" | "priority" | "enabled">;

export interface ApplyRulesResult {
  categorized: number;
  /** Transactions still without a category (and not itemized) afterwards. */
  uncategorized: number;
}

export interface RulePreview {
  /** All transactions the pattern matches, categorized or not. */
  total: number;
  /** How many of those are currently uncategorized. */
  uncategorized: number;
  examples: { id: string; postedDate: string; description: string; details: string[]; amount: number; categoryName: string | null }[];
}
