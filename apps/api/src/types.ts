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

export type AccountKind = "checking" | "savings" | "credit_card" | "other";

/** A bank account or card that transactions belong to. */
export interface Account {
  id: number;
  /** What the user calls it; starts as the statement's product name. */
  name: string;
  kind: AccountKind;
  bank: string;
  /** As printed on statements (often masked); '' when unknown. */
  accountNumber: string;
  /**
   * Product name as printed on PDF statements, e.g. "U.S. BANK GOLD CHECKING". With bank and account number it's
   * how PDF imports find the account; null for an account no statement has matched yet.
   */
  statementName: string | null;
  createdAt: string;
  transactionCount: number;
  firstDate: string | null;
  lastDate: string | null;
  importCount: number;
  lastImportedAt: string | null;
}

export interface AccountInput {
  name: string;
  kind: AccountKind;
  bank: string;
  accountNumber: string;
  statementName?: string | null;
}

export interface AccountImportResult {
  accountId: number;
  /** True when this import created the account. */
  accountCreated: boolean;
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
  /** The receipt this item was written from, or null when entered by hand. */
  receiptId: number | null;
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

// Receipts. See docs/design/receipts.md. Amounts are in dollars, signed so a receipt's lines add up to its
// total: items, tax, tips, fees and deposits positive; discounts negative.

export type ReceiptStatus = "pending" | "extracted" | "reviewed" | "failed";
export type ReceiptLineKind = "item" | "discount" | "tax" | "tip" | "fee" | "deposit";
export type PaymentMethod = "card" | "cash" | "gift_card" | "other" | "unknown";
export type PaymentMatchStatus = "unmatched" | "suggested" | "confirmed" | "not_applicable";

/** A region of the uploaded image, as fractions of its width and height (0..1). */
export interface BoundingBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Receipt {
  id: number;
  fileId: number;
  fileName: string;
  contentType: string;
  status: ReceiptStatus;
  merchantName: string | null;
  merchantAddress: string | null;
  merchantPhone: string | null;
  purchaseDate: string | null;
  /** "HH:MM:SS", when the receipt prints a time. */
  purchaseTime: string | null;
  currency: string;
  subtotal: number | null;
  total: number | null;
  defaultCategoryId: number | null;
  extractor: string | null;
  extractorVersion: string | null;
  validationIssues: string[];
  notes: string | null;
  lines: ReceiptLine[];
  payments: ReceiptPayment[];
}

export interface ReceiptLine {
  id: string;
  position: number;
  kind: ReceiptLineKind;
  description: string;
  displayName: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  amount: number;
  sku: string | null;
  taxCode: string | null;
  /** For a discount on one item: that item's line id. */
  appliesToLineId: string | null;
  categoryId: number | null;
  confidence: number | null;
  bbox: BoundingBox | null;
}

export interface ReceiptPayment {
  id: number;
  method: PaymentMethod;
  cardBrand: string | null;
  cardLast4: string | null;
  /** Positive for a purchase, negative for a refund. */
  amount: number;
  transactionId: string | null;
  matchStatus: PaymentMatchStatus;
  matchScore: number | null;
  /** How much more the matched transaction is than this payment (a tip added later, a pre-auth); null if unmatched. */
  amountDelta: number | null;
}

/** What an extractor (OCR, a hosted API or a vision model) returns for a receipt, whichever one it is. */
export interface ReceiptExtraction {
  merchant: { name: string | null; address: string | null; phone: string | null };
  /** `date` is "YYYY-MM-DD"; `time` is "HH:MM" or "HH:MM:SS". */
  purchasedAt: { date: string | null; time: string | null };
  /** ISO 4217 code; null means USD. */
  currency: string | null;
  subtotal: number | null;
  total: number | null;
  lines: ReceiptExtractionLine[];
  payments: ReceiptExtractionPayment[];
}

export interface ReceiptExtractionLine {
  kind: ReceiptLineKind;
  description: string;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  amount: number;
  sku: string | null;
  taxCode: string | null;
  /** Index into `lines` of the item a discount belongs to. */
  appliesToIndex: number | null;
  /** The extractor's guess at a category name; matched to an existing category when saved. */
  suggestedCategory: string | null;
  confidence: number | null;
  bbox: BoundingBox | null;
}

export interface ReceiptExtractionPayment {
  method: PaymentMethod;
  cardBrand: string | null;
  cardLast4: string | null;
  amount: number;
}
