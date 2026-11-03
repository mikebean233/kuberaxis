import { extractPages, lineText, type PdfPage, type TextItem, type TextLine } from "../../pdf/extractLines.js";
import type {
  AccountSummary,
  DailyBalance,
  IsoDate,
  Transaction,
  UsBankAccount,
  UsBankStatement,
  ValidationResult,
} from "./types.js";

export interface ParseOptions {
  /** Throw a `UsBankParseError` if any account fails validation. Defaults to false. */
  strict?: boolean;
}

export class UsBankParseError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length ? `${message}:\n  - ${issues.join("\n  - ")}` : message);
    this.name = "UsBankParseError";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const AMOUNT_RE = /^\d{1,3}(?:,\d{3})*\.\d{2}-?$/;
const FULL_DATE_RE = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/;
const SHORT_DATE_RE = /^([A-Z][a-z]{2}) (\d{1,2})$/;
const TOTAL_RE = /^(Total .+?|.+ Subtotal)\s+(?:\$\s+)?(\d{1,3}(?:,\d{3})*\.\d{2}-?)$/;
const BALANCE_ENTRY_RE = /([A-Z][a-z]{2}) (\d{1,2}) (\d{1,3}(?:,\d{3})*\.\d{2}-?)/g;
/** Headings sit at the left margin (x ~= 20); anything past this is not a heading. */
const LEFT_MARGIN_MAX_X = 40;
/** Account Summary labels starting past this are in the right-hand column (days, averages, interest). */
const SUMMARY_RIGHT_COLUMN_X = 300;

export async function parseUsBankStatement(data: Uint8Array, options: ParseOptions = {}): Promise<UsBankStatement> {
  const pages = await extractPages(data);
  const statement = parsePages(pages);
  if (options.strict) {
    const issues = statement.accounts.flatMap((a) => a.validation.issues.map((i) => `${a.name}: ${i}`));
    if (issues.length) throw new UsBankParseError("Statement failed validation", issues);
  }
  return statement;
}

export function parsePages(pages: PdfPage[]): UsBankStatement {
  const firstPage = pages[0];
  if (!firstPage) throw new UsBankParseError("PDF has no pages");

  const header = parseHeader(firstPage);
  const accounts = new AccountParser(header.period).parse(pages);
  if (accounts.length === 0) throw new UsBankParseError("No accounts found; is this a U.S. Bank statement?");

  return { bank: "U.S. Bank", ...header, accounts };
}

// ---------------------------------------------------------------------------
// First-page header
// ---------------------------------------------------------------------------

function parseHeader(page: PdfPage): Pick<UsBankStatement, "accountNumber" | "period" | "customerLines"> {
  const items = page.lines.flatMap((l) => l.items);

  const periodDates = items.filter((i) => FULL_DATE_RE.test(i.str)).slice(0, 2);
  const [startItem, endItem] = periodDates;
  if (!startItem || !endItem) throw new UsBankParseError("Could not find the statement period on page 1");

  // The value is the first item below the "Account Number:" label in the same column.
  let accountNumber: string | null = null;
  const label = items.find((i) => i.str === "Account Number:");
  if (label) {
    const below = items
      .filter((i) => i.y < label.y && i.y > label.y - 20 && Math.abs(i.x - label.x) < 30)
      .sort((a, b) => b.y - a.y)[0];
    accountNumber = below?.str ?? null;
  }

  return {
    accountNumber,
    period: { start: parseFullDate(startItem.str), end: parseFullDate(endItem.str) },
    customerLines: parseCustomerLines(page.lines),
  };
}

/**
 * The name/address block follows the postal barcode (a long run of A/D/F/T characters)
 * in the left column and ends at the first large vertical gap.
 */
function parseCustomerLines(lines: TextLine[]): string[] {
  const barcodeIndex = lines.findIndex((l) => l.items.some((i) => /^[ADFT]{30,}$/.test(i.str)));
  if (barcodeIndex === -1) return [];

  const result: string[] = [];
  let lastY: number | null = null;
  for (const line of lines.slice(barcodeIndex + 1)) {
    const left = line.items.filter((i) => i.x < 300);
    if (left.length === 0) continue;
    if (lastY !== null && lastY - line.y > 20) break;
    result.push(left.map((i) => i.str).join(" "));
    lastY = line.y;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Account pages
// ---------------------------------------------------------------------------

interface TableColumns {
  descriptionX: number;
  refX: number;
}

type Mode = "none" | "summary" | "table" | "balances";

interface AccountState {
  account: UsBankAccount;
  /** Card subtotal lines, keyed by last four digits. */
  cardSubtotals: Map<string, number>;
}

class AccountParser {
  private accounts: AccountState[] = [];
  private current: AccountState | null = null;
  private mode: Mode = "none";
  private columns: TableColumns | null = null;
  private lastHeading = "";
  private section = "";
  private cardLast4: string | null = null;
  private openTransaction: Transaction | null = null;
  private awaitingTableHeader = false;

  constructor(private readonly period: { start: IsoDate; end: IsoDate }) {}

  parse(pages: PdfPage[]): UsBankAccount[] {
    for (const page of pages) {
      // Transactions never continue across a page break, and each continuation page
      // repeats the statement header before re-printing the table header.
      this.openTransaction = null;
      if (this.mode === "table") this.awaitingTableHeader = true;
      for (const line of page.lines) this.handleLine(line);
    }
    return this.accounts.map((state) => {
      // The Balance Summary table is laid out in columns, so it is read across rather than in date order.
      state.account.dailyBalances.sort((a, b) => a.date.localeCompare(b.date));
      state.account.validation = validate(state);
      return state.account;
    });
  }

  private handleLine(line: TextLine): void {
    const items = line.items;
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const text = lineText(line);

    // "U.S. BANK SMARTLY CHECKING ... Member FDIC" starts an account; "(CONTINUED)" resumes it.
    // "IMAGES FOR YOUR ... ACCOUNT ... Member FDIC" starts check images, which are not an account.
    if (first.x < LEFT_MARGIN_MAX_X && items.length >= 2) {
      if (last.str === "Member FDIC") {
        if (/^IMAGES FOR YOUR\b/i.test(first.str)) {
          this.current = null;
          this.setMode("none");
        } else {
          this.startAccount(first.str);
        }
        return;
      }
      if (last.str === "(CONTINUED)") {
        this.current = [...this.accounts].reverse().find((s) => s.account.name === first.str) ?? this.current;
        return;
      }
    }

    const state = this.current;
    if (!state) return;

    const accountNumber = findAccountNumber(items);
    if (accountNumber) {
      state.account.accountNumber ??= accountNumber;
      return;
    }

    if (text === "Account Summary") {
      this.setMode("summary");
      return;
    }

    if (first.str === "Date" && items.some((i) => i.str === "Description of Transaction")) {
      this.startTable(items);
      return;
    }

    if (first.str === "Date" && items.some((i) => i.str === "Ending Balance")) {
      this.setMode("balances");
      return;
    }

    const cardMatch = /^Card Number: .*?(\d{4})$/.exec(text);
    if (cardMatch?.[1]) {
      this.cardLast4 = cardMatch[1];
      return;
    }

    if (first.x > LEFT_MARGIN_MAX_X) {
      const totalMatch = TOTAL_RE.exec(text);
      if (totalMatch?.[1] && totalMatch[2]) {
        this.recordTotal(state, totalMatch[1], parseAmount(totalMatch[2]));
        return;
      }
    }

    switch (this.mode) {
      case "summary":
        if (this.handleSummaryLine(state.account.summary, items)) return;
        this.setMode("none");
        break;
      case "table":
        // Still record headings: the "(continued)" heading above the repeated table header
        // names the section, and a stray line on the previous page may have been taken as one.
        if (this.awaitingTableHeader) break;
        if (this.handleTableLine(state, line)) return;
        break;
      case "balances":
        if (this.handleBalanceLine(state.account.dailyBalances, text)) return;
        break;
    }

    if (items.length === 1 && first.x < LEFT_MARGIN_MAX_X) this.lastHeading = first.str;
  }

  private startAccount(name: string): void {
    this.current = {
      account: {
        name,
        accountNumber: null,
        summary: { beginningBalance: null, endingBalance: null, daysInPeriod: null, averageBalance: null, lines: [], details: [] },
        transactions: [],
        sectionTotals: {},
        dailyBalances: [],
        validation: { ok: true, issues: [] },
      },
      cardSubtotals: new Map(),
    };
    this.accounts.push(this.current);
    this.setMode("none");
    this.lastHeading = "";
    this.cardLast4 = null;
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.openTransaction = null;
    this.awaitingTableHeader = false;
  }

  private startTable(items: TextItem[]): void {
    const description = items.find((i) => i.str === "Description of Transaction");
    const ref = items.find((i) => i.str === "Ref Number");
    const amount = items.find((i) => i.str === "Amount");
    if (!description || !amount) throw new UsBankParseError("Unrecognized transaction table header");

    this.section = this.lastHeading.replace(/\s*\(continued\)$/i, "");
    this.columns = { descriptionX: description.x, refX: ref?.x ?? amount.x };
    this.setMode("table");
  }

  private recordTotal(state: AccountState, label: string, value: number): void {
    const cardSubtotal = /^Card (\d{4}) .*Subtotal$/.exec(label);
    if (cardSubtotal?.[1]) {
      state.cardSubtotals.set(cardSubtotal[1], value);
    } else {
      state.account.sectionTotals[label.replace(/^Total /, "")] = value;
      this.cardLast4 = null;
      this.setMode("none");
    }
    this.openTransaction = null;
  }

  /** Returns false when the line has no label/value pairs (i.e. the summary box has ended). */
  private handleSummaryLine(summary: AccountSummary, items: TextItem[]): boolean {
    let label: TextItem[] = [];
    let found = false;
    for (const item of items) {
      if (item.str === "$") continue;
      // e.g. "Annual Percentage Yield Earned 0.01%": not a dollar figure, so drop the label.
      if (/^\d+(?:\.\d+)?%$/.test(item.str)) {
        label = [];
        continue;
      }
      if (AMOUNT_RE.test(item.str) || /^\d+$/.test(item.str)) {
        const first = label[0];
        if (!first) continue;
        const name = label.map((i) => i.str).join(" ");
        const value = parseAmount(item.str);
        (first.x < SUMMARY_RIGHT_COLUMN_X ? summary.lines : summary.details).push({ label: name, value });
        if (/^Beginning Balance\b/.test(name)) summary.beginningBalance = value;
        else if (/^Ending Balance\b/.test(name)) summary.endingBalance = value;
        else if (/^Number of Days\b/.test(name)) summary.daysInPeriod = value;
        else if (/^Average Account Balance\b/.test(name)) summary.averageBalance = value;
        label = [];
        found = true;
      } else {
        label.push(item);
      }
    }
    return found;
  }

  /** Returns false when the line is not part of the current table. */
  private handleTableLine(state: AccountState, line: TextLine): boolean {
    const columns = this.columns;
    if (!columns) return false;

    const dateItems = line.items.filter((i) => i.x < columns.descriptionX - 2);
    const bodyItems = line.items.filter((i) => i.x >= columns.descriptionX - 2);
    const amountItem = [...bodyItems].reverse().find((i) => i.x >= columns.refX - 2 && AMOUNT_RE.test(i.str));

    if (dateItems.length > 0) {
      const dateText = dateItems.map((i) => i.str).join(" ");
      if (!SHORT_DATE_RE.test(dateText) || !amountItem) return false;

      const textItems = bodyItems.filter((i) => i !== amountItem && i.str !== "$");
      const descItems = textItems.filter((i) => i.x < columns.refX - 2);
      const refItems = textItems.filter((i) => i.x >= columns.refX - 2);
      const [typeItem, ...descriptionItems] = descItems;

      const transaction: Transaction = {
        date: this.resolveShortDate(dateText),
        section: this.section,
        type: typeItem?.str ?? "",
        description: descriptionItems.map((i) => i.str).join(" "),
        details: [],
        refNumber: refItems.length ? refItems.map((i) => i.str).join(" ") : null,
        amount: parseAmount(amountItem.str),
        transactionDate: null,
        cardLast4: this.cardLast4,
        page: line.page,
      };
      transaction.transactionDate = findTransactionDate(transaction.description);
      state.account.transactions.push(transaction);
      this.openTransaction = transaction;
      return true;
    }

    // Continuation lines are indented under the description column and carry no amount.
    const open = this.openTransaction;
    const first = line.items[0];
    if (open && first && !amountItem && first.x < columns.refX) {
      const detail = lineText(line);
      open.details.push(detail);
      open.transactionDate ??= findTransactionDate(detail);
      return true;
    }
    return false;
  }

  private handleBalanceLine(balances: DailyBalance[], text: string): boolean {
    let found = false;
    for (const match of text.matchAll(BALANCE_ENTRY_RE)) {
      const [, month, day, amount] = match;
      if (!month || !day || !amount) continue;
      balances.push({ date: this.resolveShortDate(`${month} ${day}`), balance: parseAmount(amount) });
      found = true;
    }
    return found;
  }

  /** Resolves a year-less "Mon D" date to the year that places it inside the statement period. */
  private resolveShortDate(text: string): IsoDate {
    const match = SHORT_DATE_RE.exec(text);
    if (!match?.[1] || !match[2]) throw new UsBankParseError(`Invalid date "${text}"`);
    return resolveYear(monthIndex(match[1]), Number(match[2]), this.period);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate({ account, cardSubtotals }: AccountState): ValidationResult {
  const issues: string[] = [];
  const { summary, transactions, sectionTotals } = account;
  const cents = (n: number) => Math.round(n * 100);
  const sumCents = (txns: Transaction[]) => txns.reduce((acc, t) => acc + cents(t.amount), 0);
  const fmt = (c: number) => (c / 100).toFixed(2);

  if (summary.beginningBalance === null) issues.push("Missing beginning balance");
  if (summary.endingBalance === null) issues.push("Missing ending balance");

  if (summary.beginningBalance !== null && summary.endingBalance !== null) {
    const computed = cents(summary.beginningBalance) + sumCents(transactions);
    if (computed !== cents(summary.endingBalance)) {
      issues.push(`Beginning balance + transactions = ${fmt(computed)}, but ending balance is ${summary.endingBalance.toFixed(2)}`);
    }
  }

  const sections = new Map<string, Transaction[]>();
  for (const t of transactions) sections.set(t.section, [...(sections.get(t.section) ?? []), t]);

  for (const [section, total] of Object.entries(sectionTotals)) {
    const actual = sumCents(sections.get(section) ?? []);
    // Totals are printed unsigned for credits and with a trailing "-" for debits, matching our sign convention.
    if (actual !== cents(total)) issues.push(`Section "${section}" sums to ${fmt(actual)}, but its printed total is ${total.toFixed(2)}`);
  }
  for (const [section, txns] of sections) {
    if (!(section in sectionTotals)) issues.push(`Section "${section}" (${txns.length} transactions) has no printed total`);
  }

  for (const [card, subtotal] of cardSubtotals) {
    const actual = sumCents(transactions.filter((t) => t.cardLast4 === card));
    if (actual !== cents(subtotal)) issues.push(`Card ${card} transactions sum to ${fmt(actual)}, but the subtotal is ${subtotal.toFixed(2)}`);
  }

  const balanceLabels = /^(Beginning Balance|Ending Balance)\b/;
  for (const { label, value } of summary.lines) {
    if (balanceLabels.test(label)) continue;
    const txns = sections.get(label);
    if (!txns) {
      if (value !== 0) issues.push(`Account Summary line "${label}" (${value.toFixed(2)}) has no matching transaction section`);
      continue;
    }
    const actual = sumCents(txns);
    if (actual !== cents(value)) issues.push(`Account Summary "${label}" is ${value.toFixed(2)}, but its transactions sum to ${fmt(actual)}`);
  }

  // Replay transactions day by day against the Balance Summary table. Some account types
  // (e.g. savings) don't print one; the ending-balance check above still covers them.
  if (summary.beginningBalance !== null && account.dailyBalances.length > 0) {
    const byDate = new Map<IsoDate, number>();
    for (const t of transactions) byDate.set(t.date, (byDate.get(t.date) ?? 0) + cents(t.amount));
    const reported = new Map(account.dailyBalances.map((b) => [b.date, cents(b.balance)]));
    let running = cents(summary.beginningBalance);
    for (const date of [...byDate.keys()].sort()) {
      running += byDate.get(date) ?? 0;
      const expected = reported.get(date);
      if (expected === undefined) issues.push(`No Balance Summary entry for ${date}, which has transactions`);
      else if (expected !== running) issues.push(`Running balance on ${date} is ${fmt(running)}, but Balance Summary shows ${fmt(expected)}`);
    }
    for (const date of reported.keys()) {
      if (!byDate.has(date)) issues.push(`Balance Summary has an entry for ${date}, but no transactions were parsed for that date`);
    }
  }

  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Printed on the same baseline as "U.S. Bank National Association". pdf.js returns it as one item
 * ("Account Number 1234") or as the label followed by the number, depending on the spacing.
 */
function findAccountNumber(items: TextItem[]): string | null {
  for (const [index, item] of items.entries()) {
    const joined = /^Account Number (.+)$/.exec(item.str);
    if (joined?.[1]) return joined[1];
    if (item.str === "Account Number") return items[index + 1]?.str ?? null;
  }
  return null;
}

/** "1,234.56-" -> -1234.56 */
function parseAmount(text: string): number {
  const negative = text.endsWith("-");
  const value = Number(text.replace(/[,-]/g, ""));
  if (Number.isNaN(value)) throw new UsBankParseError(`Invalid amount "${text}"`);
  return negative ? -value : value;
}

function monthIndex(name: string): number {
  const index = MONTHS.indexOf(name);
  if (index === -1) throw new UsBankParseError(`Unknown month "${name}"`);
  return index;
}

function isoDate(year: number, monthIdx: number, day: number): IsoDate {
  return `${year}-${String(monthIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseFullDate(text: string): IsoDate {
  const match = FULL_DATE_RE.exec(text);
  if (!match?.[1] || !match[2] || !match[3]) throw new UsBankParseError(`Invalid date "${text}"`);
  return isoDate(Number(match[3]), monthIndex(match[1]), Number(match[2]));
}

/** Picks the year that puts the date on or before the period end (handles Dec -> Jan statements). */
function resolveYear(monthIdx: number, day: number, period: { end: IsoDate }): IsoDate {
  const endYear = Number(period.end.slice(0, 4));
  const candidate = isoDate(endYear, monthIdx, day);
  return candidate <= period.end ? candidate : isoDate(endYear - 1, monthIdx, day);
}

/** Card transactions carry the purchase date as "On MMDDYY". */
function findTransactionDate(text: string): IsoDate | null {
  const match = /\bOn (\d{2})(\d{2})(\d{2})\b/.exec(text);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return isoDate(2000 + Number(match[3]), month - 1, day);
}
