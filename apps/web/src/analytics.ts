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
