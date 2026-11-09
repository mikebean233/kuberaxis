import type { Category, TransactionRow } from "./api";

/** "2026-09" */
export type MonthKey = string;

/** The date money was spent: when the card was used, if known, else when it posted. */
export const spendDate = (t: TransactionRow) => t.transactionDate ?? t.postedDate;

export const monthOf = (iso: string): MonthKey => iso.slice(0, 7);

/** Monday of the week containing `iso`, as "YYYY-MM-DD". */
export function weekOf(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/** The `count` consecutive months ending with `last`, oldest first. */
export function monthsEnding(last: MonthKey, count: number): MonthKey[] {
  const [y, m] = last.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(y!, m! - 1 - (count - 1 - i), 1));
    return date.toISOString().slice(0, 7);
  });
}

/** Every week start from `first` to `last` inclusive. */
export function weeksBetween(first: string, last: string): string[] {
  const weeks: string[] = [];
  const date = new Date(`${weekOf(first)}T00:00:00Z`);
  const end = new Date(`${weekOf(last)}T00:00:00Z`);
  for (; date <= end; date.setUTCDate(date.getUTCDate() + 7)) weeks.push(date.toISOString().slice(0, 10));
  return weeks;
}

/** The most recent spend date, or null when there are no transactions. */
export function latestDate(transactions: TransactionRow[]): string | null {
  let latest: string | null = null;
  for (const t of transactions) {
    const date = spendDate(t);
    if (latest === null || date > latest) latest = date;
  }
  return latest;
}

/** The most recent month with any transaction, or null when there are none. */
export function latestMonth(transactions: TransactionRow[]): MonthKey | null {
  const latest = latestDate(transactions);
  return latest && monthOf(latest);
}

/** Last day of a month, "YYYY-MM-DD". */
export function endOfMonth(month: MonthKey): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

/**
 * Chart labels for a month. When the data stops partway through it (the latest statement ends on the 8th),
 * the labels say so, so a short month isn't read as a drop.
 */
export function monthPeriod(month: MonthKey, latest: string | null, { initial = false } = {}) {
  const day = latest && monthOf(latest) === month && latest < endOfMonth(month) ? Number(latest.slice(8, 10)) : null;
  const short = initial ? monthLabel(month).slice(0, 1) : monthLabel(month);
  return {
    key: month,
    label: day === null ? short : `${short} 1–${day}`,
    longLabel: day === null ? monthLabel(month, true) : `${monthLabel(month)} 1–${day}, ${month.slice(0, 4)} (so far)`,
    partialThrough: day,
  };
}

export interface KindTotals {
  /** Money spent in spending categories, net of refunds in them. Cents. */
  spending: number;
  income: number;
  /** Net of everything without a category (signed like amounts). */
  uncategorized: number;
}

const emptyTotals = (): KindTotals => ({ spending: 0, income: 0, uncategorized: 0 });

/** Spending, income and uncategorized totals per period; transfers are left out. */
export function totalsByPeriod(
  transactions: TransactionRow[],
  categories: Category[],
  periods: string[],
  periodOf: (iso: string) => string,
): Map<string, KindTotals> {
  const kinds = new Map(categories.map((c) => [c.id, c.kind]));
  const totals = new Map(periods.map((p) => [p, emptyTotals()]));
  for (const t of transactions) {
    const bucket = totals.get(periodOf(spendDate(t)));
    if (!bucket) continue;
    for (const { categoryId, amount } of t.allocations) {
      const cents = Math.round(amount * 100);
      const kind = categoryId === null ? undefined : kinds.get(categoryId);
      if (kind === "expense") bucket.spending -= cents;
      else if (kind === "income") bucket.income += cents;
      else if (kind === undefined) bucket.uncategorized += cents;
    }
  }
  return totals;
}

/** Id used for money out without a category in spending breakdowns. */
export const UNCATEGORIZED_ID = -1;

/** Which side of the ledger a category breakdown covers. */
export type FlowKind = "expense" | "income";

/**
 * Cents per period and category for one kind of category, counted positive in the direction of that kind:
 * spending is money out net of refunds, income is money in net of reversals. For spending, uncategorized money
 * out counts too (under UNCATEGORIZED_ID), since it's most likely spending that just isn't categorized yet.
 * Uncategorized money in is left out of income: on a card statement it's mostly payments and refunds.
 */
export function amountsByCategory(
  transactions: TransactionRow[],
  categories: Category[],
  kind: FlowKind,
  periods: string[],
  periodOf: (iso: string) => string,
): Map<string, Map<number, number>> {
  const kinds = new Map(categories.map((c) => [c.id, c.kind]));
  const sign = kind === "expense" ? -1 : 1;
  const result = new Map(periods.map((p) => [p, new Map<number, number>()]));
  for (const t of transactions) {
    const bucket = result.get(periodOf(spendDate(t)));
    if (!bucket) continue;
    for (const { categoryId, amount } of t.allocations) {
      const cents = Math.round(amount * 100);
      let id: number;
      if (categoryId === null) {
        if (kind !== "expense" || cents >= 0) continue;
        id = UNCATEGORIZED_ID;
      } else if (kinds.get(categoryId) === kind) {
        id = categoryId;
      } else {
        continue;
      }
      bucket.set(id, (bucket.get(id) ?? 0) + sign * cents);
    }
  }
  return result;
}

/** Spending in cents per period and category; see amountsByCategory. */
export const spendingByCategory = (
  transactions: TransactionRow[],
  categories: Category[],
  periods: string[],
  periodOf: (iso: string) => string,
) => amountsByCategory(transactions, categories, "expense", periods, periodOf);

/** Category ids of one kind ordered by their total across all of `transactions`, largest first. */
export function rankCategories(transactions: TransactionRow[], categories: Category[], kind: FlowKind = "expense"): number[] {
  const all = amountsByCategory(transactions, categories, kind, ["all"], () => "all").get("all")!;
  return [...all.entries()]
    .filter(([id, cents]) => id !== UNCATEGORIZED_ID && cents > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

const monthFormat = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const monthYearFormat = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Sep" (or "Sep 2026" with `withYear`). */
export const monthLabel = (month: MonthKey, withYear = false) =>
  (withYear ? monthYearFormat : monthFormat).format(new Date(`${month}-01T00:00:00Z`));

/** "Sep 8" for a week starting then. */
export const weekLabel = (week: string) => dayFormat.format(new Date(`${week}T00:00:00Z`));

/** "Aug – Oct 2026", or "Nov 2025 – Jan 2026" across a year boundary. */
export function monthRangeLabel(first: MonthKey, last: MonthKey): string {
  if (first === last) return monthLabel(first, true);
  return first.slice(0, 4) === last.slice(0, 4)
    ? `${monthLabel(first)} – ${monthLabel(last, true)}`
    : `${monthLabel(first, true)} – ${monthLabel(last, true)}`;
}

const compact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Whole dollars under $10,000 ("$8,412"), compact above ("$12.9K"). */
export const formatDollarsShort = (cents: number) => (Math.abs(cents) < 1_000_000 ? whole : compact).format(cents / 100);

/** Clean axis ticks from 0 to at least `max` (cents): 0, step, 2·step, … with step 1, 2, 2.5 or 5 × 10ⁿ. */
export function niceTicks(max: number, target = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(v);
  return ticks;
}

/** How long a pivot period is. */
export type PeriodSize = "month" | "quarter" | "half" | "year";

/** A span of dates, both ends inclusive ("YYYY-MM-DD"). */
export interface DateSpan {
  key: string;
  label: string;
  start: string;
  end: string;
}

const MONTHS_IN: Record<PeriodSize, number> = { month: 1, quarter: 3, half: 6, year: 12 };

/** The period of `size` containing `iso`: "2026-09" / "2026-Q3" / "2026-H2" / "2026". */
export function spanOf(size: PeriodSize, iso: string): DateSpan {
  const year = iso.slice(0, 4);
  const index = Math.floor((Number(iso.slice(5, 7)) - 1) / MONTHS_IN[size]);
  const firstMonth = `${year}-${String(index * MONTHS_IN[size] + 1).padStart(2, "0")}`;
  const lastMonth = addMonths(firstMonth, MONTHS_IN[size] - 1);
  const key = { month: firstMonth, quarter: `${year}-Q${index + 1}`, half: `${year}-H${index + 1}`, year }[size];
  const label = {
    month: monthLabel(firstMonth, true),
    quarter: `Q${index + 1} ${year}`,
    half: `${index === 0 ? "Jan – Jun" : "Jul – Dec"} ${year}`,
    year,
  }[size];
  return { key, label, start: `${firstMonth}-01`, end: endOfMonth(lastMonth) };
}

function addMonths(month: MonthKey, count: number): MonthKey {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + count, 1)).toISOString().slice(0, 7);
}

/** Every period of `size` from the one containing `first` to the one containing `last`, newest first. */
export function spansBetween(size: PeriodSize, first: string, last: string): DateSpan[] {
  const spans: DateSpan[] = [];
  for (let span = spanOf(size, last); span.end >= first; span = spanOf(size, addMonths(span.start.slice(0, 7), -1))) {
    spans.push(span);
  }
  return spans;
}

/** The earliest spend date, or null when there are no transactions. */
export function earliestDate(transactions: TransactionRow[]): string | null {
  let earliest: string | null = null;
  for (const t of transactions) {
    const date = spendDate(t);
    if (earliest === null || date < earliest) earliest = date;
  }
  return earliest;
}

/** Where a pivot puts money: counted as income or spending, or shown but not counted. */
export type PivotSection = "income" | "expense" | "other";

/** One transaction's part in a pivot category. */
export interface PivotEntry {
  transaction: TransactionRow;
  /** Its contribution, signed like the category's total. */
  cents: number;
  /** True when the rest of the transaction is in other categories. */
  partial: boolean;
}

export interface PivotCategory {
  /** A category id, UNCATEGORIZED_ID for uncategorized money out, UNCATEGORIZED_IN_ID for money in. */
  id: number;
  total: number;
  entries: PivotEntry[];
}

export interface PivotGroup {
  section: PivotSection;
  total: number;
  categories: PivotCategory[];
}

/** Id for uncategorized money in, which (like transfers) is shown in a pivot but not counted as income. */
export const UNCATEGORIZED_IN_ID = -3;

/**
 * Everything dated within `span`, by section and category, with the transactions behind each category. Income
 * counts money in and spending money out (each net of reversals and refunds), the same way as the category
 * breakdowns, including uncategorized money out under spending. Transfers and uncategorized money in are kept
 * under "other", signed like transaction amounts.
 */
export function pivotByCategory(
  transactions: TransactionRow[],
  categories: Category[],
  span: { start: string; end: string },
): PivotGroup[] {
  const kinds = new Map(categories.map((c) => [c.id, c.kind]));
  const sections = new Map<PivotSection, Map<number, PivotCategory>>([
    ["income", new Map()],
    ["expense", new Map()],
    ["other", new Map()],
  ]);
  for (const t of transactions) {
    const date = spendDate(t);
    if (date < span.start || date > span.end) continue;
    // A transaction itemized into several parts of one category shows once there, with those parts combined.
    const parts = new Map<string, { section: PivotSection; id: number; cents: number }>();
    for (const { categoryId, amount } of t.allocations) {
      const cents = Math.round(amount * 100);
      const kind = categoryId === null ? null : kinds.get(categoryId);
      let section: PivotSection;
      let id: number;
      if (kind === "income") [section, id] = ["income", categoryId!];
      else if (kind === "expense") [section, id] = ["expense", categoryId!];
      else if (kind === null || kind === undefined)
        [section, id] = cents < 0 ? ["expense", UNCATEGORIZED_ID] : ["other", UNCATEGORIZED_IN_ID];
      else [section, id] = ["other", categoryId!];
      const signed = section === "expense" ? -cents : cents;
      const key = `${section}:${id}`;
      const part = parts.get(key);
      if (part) part.cents += signed;
      else parts.set(key, { section, id, cents: signed });
    }
    for (const { section, id, cents } of parts.values()) {
      const byId = sections.get(section)!;
      const category = byId.get(id) ?? { id, total: 0, entries: [] };
      byId.set(id, category);
      category.total += cents;
      category.entries.push({ transaction: t, cents, partial: parts.size > 1 });
    }
  }
  return [...sections.entries()].map(([section, byId]) => {
    const list = [...byId.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    for (const c of list) c.entries.sort((a, b) => spendDate(b.transaction).localeCompare(spendDate(a.transaction)));
    return { section, total: list.reduce((sum, c) => sum + c.total, 0), categories: list };
  });
}

/** Time units a period's amounts are averaged over, as days (a year is 365 days). */
export const RATE_UNITS = [
  { id: "day", label: "Per day", days: 1 },
  { id: "month", label: "Per month", days: 365 / 12 },
  { id: "quarter", label: "Per quarter", days: 365 / 4 },
  { id: "half", label: "Per half", days: 365 / 2 },
  { id: "year", label: "Per year", days: 365 },
] as const;

const daysBetween = (start: string, end: string) =>
  (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;

/** The first and last transaction dates of an account's data (null when it has none). */
export interface DataRange {
  firstDate: string | null;
  lastDate: string | null;
}

/**
 * Days of the span an account has data for: from its first transaction date (or the span's start, if later) through
 * its last (or the span's end, if sooner), both inclusive. 0 when its data doesn't overlap the span.
 */
export function coveredDays(span: { start: string; end: string }, { firstDate, lastDate }: DataRange): number {
  if (firstDate === null || lastDate === null) return 0;
  const start = firstDate > span.start ? firstDate : span.start;
  const end = lastDate < span.end ? lastDate : span.end;
  return end < start ? 0 : daysBetween(start, end) + 1;
}

/**
 * Cents per day across accounts, each prorated over the days it has data for, so an account whose data starts late
 * or stops early isn't averaged over days it has no data for. Multiply by a unit's `days` for that unit.
 */
export function perDay(
  parts: { accountId: number; cents: number }[],
  span: { start: string; end: string },
  ranges: Map<number, DataRange>,
): number {
  let rate = 0;
  for (const { accountId, cents } of parts) {
    const range = ranges.get(accountId) ?? { firstDate: null, lastDate: null };
    rate += cents / Math.max(coveredDays(span, range), 1);
  }
  return rate;
}

/**
 * Whether a unit is shorter than the period, so a per-unit average means something: a calendar period (or rolling
 * one of the same length) shows only the smaller units; other spans show units at least 10% shorter than them.
 */
export function rateUnitApplies(unit: (typeof RATE_UNITS)[number]["id"], size: PeriodSize | null, span: DateSpan): boolean {
  const index = RATE_UNITS.findIndex((u) => u.id === unit);
  if (size !== null) return index < RATE_UNITS.findIndex((u) => u.id === size);
  return RATE_UNITS[index]!.days * 1.1 < daysBetween(span.start, span.end) + 1;
}
