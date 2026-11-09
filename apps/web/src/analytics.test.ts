import { describe, expect, it } from "vitest";
import {
  coveredDays,
  hasUnitOfData,
  minCoveredDays,
  perDay,
  RATE_UNITS,
  rateUnitApplies,
  formatDollarsShort,
  latestMonth,
  monthRangeLabel,
  monthsEnding,
  niceTicks,
  amountsByCategory,
  pivotByCategory,
  spanOf,
  spansBetween,
  UNCATEGORIZED_IN_ID,
  rankCategories,
  spendingByCategory,
  totalsByPeriod,
  UNCATEGORIZED_ID,
  weekOf,
  weeksBetween,
  monthOf,
  monthPeriod,
} from "./analytics";
import type { Category, TransactionRow } from "./api";

const categories: Category[] = [
  { id: 1, name: "Groceries", kind: "expense" },
  { id: 2, name: "Paycheck", kind: "income" },
  { id: 3, name: "Credit Card Payment", kind: "transfer" },
  { id: 4, name: "Fuel", kind: "expense" },
];

let nextId = 0;
function tx(
  date: string,
  allocations: { categoryId: number | null; amount: number }[],
  transactionDate: string | null = null,
): TransactionRow {
  return {
    id: String(nextId++),
    postedDate: date,
    transactionDate,
    amount: allocations.reduce((s, a) => s + a.amount, 0),
    allocations,
  } as TransactionRow;
}

describe("dates", () => {
  it("lists months ending at a month, across a year boundary", () => {
    expect(monthsEnding("2026-02", 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("finds the Monday of a week", () => {
    expect(weekOf("2026-11-04")).toBe("2026-11-02"); // Wednesday
    expect(weekOf("2026-11-02")).toBe("2026-11-02"); // Monday
    expect(weekOf("2026-11-08")).toBe("2026-11-02"); // Sunday
    expect(weeksBetween("2026-10-28", "2026-11-10")).toEqual(["2026-10-26", "2026-11-02", "2026-11-09"]);
  });

  it("labels month ranges", () => {
    expect(monthRangeLabel("2026-08", "2026-10")).toBe("Aug – Oct 2026");
    expect(monthRangeLabel("2025-11", "2026-01")).toBe("Nov 2025 – Jan 2026");
  });

  it("marks a month the data stops partway through", () => {
    expect(monthPeriod("2026-10", "2026-10-08")).toMatchObject({ label: "Oct 1–8", longLabel: "Oct 1–8, 2026 (so far)", partialThrough: 8 });
    expect(monthPeriod("2026-10", "2026-10-31")).toMatchObject({ label: "Oct", partialThrough: null });
    expect(monthPeriod("2026-09", "2026-10-08")).toMatchObject({ label: "Sep", longLabel: "Sep 2026", partialThrough: null });
  });

  it("uses the card date over the posting date", () => {
    expect(latestMonth([tx("2026-10-01", [], "2026-09-29"), tx("2026-08-15", [])])).toBe("2026-09");
    expect(latestMonth([])).toBeNull();
  });
});

describe("totals", () => {
  const data = [
    tx("2026-09-03", [{ categoryId: 1, amount: -50 }]),
    tx("2026-09-04", [{ categoryId: 1, amount: 10 }]), // refund
    tx("2026-09-05", [{ categoryId: 2, amount: 2000 }]),
    tx("2026-09-06", [{ categoryId: 3, amount: -500 }]), // transfer: ignored
    tx("2026-09-07", [{ categoryId: null, amount: -20 }]),
    tx("2026-09-08", [
      { categoryId: 1, amount: -30 },
      { categoryId: 4, amount: -15.5 },
    ]),
    tx("2026-10-01", [{ categoryId: 4, amount: -40 }]),
    tx("2026-07-01", [{ categoryId: 4, amount: -999 }]), // outside the periods
  ];

  it("totals spending, income and uncategorized per month, leaving out transfers", () => {
    const totals = totalsByPeriod(data, categories, ["2026-09", "2026-10"], monthOf);
    expect(totals.get("2026-09")).toEqual({ spending: 8550, income: 200000, uncategorized: -2000 });
    expect(totals.get("2026-10")).toEqual({ spending: 4000, income: 0, uncategorized: 0 });
  });

  it("breaks spending down by category, counting uncategorized money out", () => {
    const byCategory = spendingByCategory(data, categories, ["2026-09"], monthOf).get("2026-09")!;
    expect(Object.fromEntries(byCategory)).toEqual({ 1: 7000, 4: 1550, [UNCATEGORIZED_ID]: 2000 });
  });

  it("breaks income down by category, leaving out uncategorized money in", () => {
    const withReversal = [
      ...data,
      tx("2026-09-20", [{ categoryId: 2, amount: -100 }]), // reversed deposit
      tx("2026-09-21", [{ categoryId: null, amount: 75 }]),
    ];
    const byCategory = amountsByCategory(withReversal, categories, "income", ["2026-09"], monthOf).get("2026-09")!;
    expect(Object.fromEntries(byCategory)).toEqual({ 2: 190000 });
  });

  it("ranks categories by all-time spending or income", () => {
    expect(rankCategories(data, categories)).toEqual([4, 1]);
    expect(rankCategories(data, categories, "income")).toEqual([2]);
  });
});

describe("pivot periods", () => {
  it("finds the month, quarter, half and year containing a date", () => {
    expect(spanOf("month", "2026-02-14")).toEqual({ key: "2026-02", label: "Feb 2026", start: "2026-02-01", end: "2026-02-28" });
    expect(spanOf("quarter", "2026-08-14")).toEqual({ key: "2026-Q3", label: "Q3 2026", start: "2026-07-01", end: "2026-09-30" });
    expect(spanOf("half", "2026-06-30")).toEqual({ key: "2026-H1", label: "Jan – Jun 2026", start: "2026-01-01", end: "2026-06-30" });
    expect(spanOf("year", "2026-12-31")).toEqual({ key: "2026", label: "2026", start: "2026-01-01", end: "2026-12-31" });
  });

  it("lists periods covering the data, newest first", () => {
    expect(spansBetween("quarter", "2025-11-20", "2026-04-02").map((s) => s.key)).toEqual(["2026-Q2", "2026-Q1", "2025-Q4"]);
    expect(spansBetween("month", "2026-01-31", "2026-02-01").map((s) => s.key)).toEqual(["2026-02", "2026-01"]);
  });
});

describe("pivot", () => {
  const data = [
    tx("2026-09-03", [{ categoryId: 1, amount: -50 }]),
    tx("2026-09-04", [{ categoryId: 1, amount: 10 }]), // refund
    tx("2026-09-05", [{ categoryId: 2, amount: 2000 }]),
    tx("2026-09-06", [{ categoryId: 3, amount: -500 }]), // transfer
    tx("2026-09-07", [{ categoryId: null, amount: -20 }]),
    tx("2026-09-07", [{ categoryId: null, amount: 35 }]),
    tx("2026-09-08", [
      { categoryId: 1, amount: -30 },
      { categoryId: 1, amount: -5 },
      { categoryId: 4, amount: -15.5 },
    ]),
    tx("2026-10-01", [{ categoryId: 4, amount: -40 }]), // outside the span
  ];
  const [income, spending, other] = pivotByCategory(data, categories, { start: "2026-09-01", end: "2026-09-30" });

  it("totals income and spending by category, net of refunds", () => {
    expect(income).toMatchObject({ section: "income", total: 200000 });
    expect(spending!.section).toBe("expense");
    expect(spending!.categories.map((c) => [c.id, c.total])).toEqual([
      [1, 7500],
      [UNCATEGORIZED_ID, 2000],
      [4, 1550],
    ]);
    expect(spending!.total).toBe(11050);
  });

  it("keeps transfers and uncategorized money in apart, signed like amounts", () => {
    expect(other!.categories.map((c) => [c.id, c.total])).toEqual([
      [3, -50000],
      [UNCATEGORIZED_IN_ID, 3500],
    ]);
  });

  it("lists the transactions behind a category, combining a transaction's parts", () => {
    const groceries = spending!.categories.find((c) => c.id === 1)!;
    expect(groceries.entries.map((e) => [e.transaction.postedDate, e.cents, e.partial])).toEqual([
      ["2026-09-08", 3500, true],
      ["2026-09-04", -1000, false],
      ["2026-09-03", 5000, false],
    ]);
  });
});

describe("axis helpers", () => {
  it("picks clean ticks that reach the maximum", () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(3_400_00)).toEqual([0, 1_000_00, 2_000_00, 3_000_00, 4_000_00]);
    expect(niceTicks(95_00)).toEqual([0, 25_00, 50_00, 75_00, 100_00]);
  });

  it("formats dollars compactly from $10,000", () => {
    expect(formatDollarsShort(8_412_37)).toBe("$8,412");
    expect(formatDollarsShort(12_900_00)).toBe("$12.9K");
  });
});

describe("per-unit averages", () => {
  const year = spanOf("year", "2025-01-01");
  const month = (id: string) => RATE_UNITS.find((u) => u.id === id)!.days;

  it("prorates over the days an account has data for", () => {
    const range = (firstDate: string | null, lastDate: string | null) => ({ firstDate, lastDate });
    expect(coveredDays(year, range("2024-06-01", "2025-12-31"))).toBe(365);
    expect(coveredDays(year, range("2024-06-01", "2026-02-01"))).toBe(365);
    expect(coveredDays(year, range("2024-06-01", "2025-09-30"))).toBe(273);
    expect(coveredDays(year, range("2025-04-01", "2025-09-30"))).toBe(183);
    expect(coveredDays(year, range("2024-06-01", "2024-12-31"))).toBe(0);
    expect(coveredDays(year, range("2026-01-01", "2026-02-01"))).toBe(0);
    expect(coveredDays(year, range(null, null))).toBe(0);

    // $750 over 273 of the year's 365 days: annualized, then a twelfth of that.
    const rate = perDay([{ accountId: 1, cents: 75_000 }], year, new Map([[1, range("2024-06-01", "2025-09-30")]]));
    expect(rate * month("month")).toBeCloseTo(75_000 / (273 / 365) / 12);
    expect(rate * month("year")).toBeCloseTo(75_000 / (273 / 365));
  });

  it("prorates each account over its own days, from its first transaction to its last", () => {
    const ranges = new Map([
      [1, { firstDate: "2024-01-01", lastDate: "2025-12-31" }],
      [2, { firstDate: "2025-04-01", lastDate: "2025-06-30" }],
    ]);
    const rate = perDay(
      [
        { accountId: 1, cents: 36_500 },
        { accountId: 2, cents: 9_100 },
      ],
      year,
      ranges,
    );
    expect(rate).toBeCloseTo(100 + 100);
  });

  it("needs a unit's worth of data from every account behind a row", () => {
    const quarter = spanOf("quarter", "2025-10-01");
    const ranges = new Map([
      [1, { firstDate: "2024-01-01", lastDate: "2025-10-08" }],
      [2, { firstDate: "2024-01-01", lastDate: "2025-12-31" }],
    ]);
    const unit = (id: string) => RATE_UNITS.find((u) => u.id === id)!;
    // 8 days of Q4: per day only, not per month (one monthly bill would read as almost 4 a month).
    expect(minCoveredDays([{ accountId: 1 }], quarter, ranges)).toBe(8);
    expect(hasUnitOfData(8, unit("day"))).toBe(true);
    expect(hasUnitOfData(8, unit("month"))).toBe(false);
    // The account with the least data decides.
    expect(minCoveredDays([{ accountId: 1 }, { accountId: 2 }], quarter, ranges)).toBe(8);
    expect(minCoveredDays([{ accountId: 2 }], quarter, ranges)).toBe(92);
    expect(hasUnitOfData(30, unit("month"))).toBe(true);
    expect(hasUnitOfData(29, unit("month"))).toBe(false);
    expect(hasUnitOfData(273, unit("half"))).toBe(true);
  });

  it("shows only units shorter than the period", () => {
    const applies = (size: Parameters<typeof rateUnitApplies>[1], span = year) =>
      RATE_UNITS.filter((u) => rateUnitApplies(u.id, size, span)).map((u) => u.id);
    expect(applies("month")).toEqual(["day"]);
    expect(applies("quarter")).toEqual(["day", "month"]);
    expect(applies("half")).toEqual(["day", "month", "quarter"]);
    expect(applies("year")).toEqual(["day", "month", "quarter", "half"]);
    // Custom dates: by length.
    expect(applies(null, { key: "c", label: "", start: "2025-01-01", end: "2025-01-31" })).toEqual(["day"]);
    expect(applies(null, { key: "c", label: "", start: "2025-01-01", end: "2025-03-15" })).toEqual(["day", "month"]);
    expect(applies(null, { key: "c", label: "", start: "2023-01-01", end: "2025-06-30" })).toEqual(RATE_UNITS.map((u) => u.id));
  });
});
