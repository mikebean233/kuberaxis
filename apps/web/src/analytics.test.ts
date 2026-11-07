import { describe, expect, it } from "vitest";
import {
  formatDollarsShort,
  latestMonth,
  monthRangeLabel,
  monthsEnding,
  niceTicks,
  amountsByCategory,
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
