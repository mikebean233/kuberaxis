import { useState } from "react";
import {
  endOfMonth,
  latestDate,
  latestMonth,
  monthPeriod,
  monthLabel,
  monthOf,
  monthRangeLabel,
  monthsEnding,
  rankSpendingCategories,
  spendDate,
  spendingByCategory,
  UNCATEGORIZED_ID,
  weekLabel,
  weekOf,
  weeksBetween,
} from "./analytics";
import type { Category, TransactionRow } from "./api";
import { ColumnChart, type ChartSeries } from "./ColumnChart";
import { formatCents } from "./format";

interface Props {
  transactions: TransactionRow[];
  categories: Category[];
}

const RANGES = [
  { id: "3", label: "Last 3 months", months: 3 },
  { id: "6", label: "Last 6 months", months: 6 },
  { id: "12", label: "Last 12 months", months: 12 },
  { id: "all", label: "All time", months: null },
] as const;

/** Categories that get their own color; the rest fold into "Other". */
const NAMED_SLOTS = 6;
const OTHER_ID = -2;

/** Spending broken down by category over time. */
export function SpendingPage({ transactions, categories }: Props) {
  const [rangeId, setRangeId] = useState<(typeof RANGES)[number]["id"]>("6");
  const [grouping, setGrouping] = useState<"month" | "week">("month");
  const [focus, setFocus] = useState<number | "all">("all");

  const last = latestMonth(transactions);
  if (!last) return <p className="empty">No transactions yet. Import a statement to get started.</p>;

  // Colors are assigned by all-time rank, so a category keeps its color whatever the range or filter.
  const ranked = rankSpendingCategories(transactions, categories);
  const named = ranked.slice(0, NAMED_SLOTS);
  const colorOf = (id: number) =>
    id === UNCATEGORIZED_ID ? "var(--viz-neutral)" : named.includes(id) ? `var(--viz-${named.indexOf(id) + 1})` : "var(--viz-7)";
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const nameOf = (id: number) => (id === UNCATEGORIZED_ID ? "Uncategorized" : id === OTHER_ID ? "Other" : (names.get(id) ?? "?"));

  const range = RANGES.find((r) => r.id === rangeId)!;
  const first =
    range.months === null
      ? monthOf(transactions.reduce((min, t) => (spendDate(t) < min ? spendDate(t) : min), spendDate(transactions[0]!)))
      : null;
  const months = range.months === null ? monthsBetween(first!, last) : monthsEnding(last, range.months);
  const periods =
    grouping === "month"
      ? months.map((m) => monthPeriod(m, latestDate(transactions), { initial: months.length > 12 }))
      : weeksBetween(`${months[0]}-01`, endOfMonth(months[months.length - 1]!)).map((w) => ({
          key: w,
          label: weekLabel(w),
          longLabel: `Week of ${weekLabel(w)}`,
        }));
  const periodOf = grouping === "month" ? monthOf : weekOf;
  const data = spendingByCategory(
    transactions,
    categories,
    periods.map((p) => p.key),
    periodOf,
  );
  const valueOf = (period: string, id: number) => data.get(period)?.get(id) ?? 0;

  // Totals per category over the range, for the table and the focus menu.
  const totals = new Map<number, number>();
  for (const bucket of data.values()) for (const [id, cents] of bucket) totals.set(id, (totals.get(id) ?? 0) + cents);
  const rows = [...totals.entries()].filter(([, cents]) => cents !== 0).sort((a, b) => b[1] - a[1]);
  const grandTotal = rows.reduce((sum, [, cents]) => sum + cents, 0);

  let series: ChartSeries[];
  if (focus === "all") {
    const inRange = new Set(totals.keys());
    const otherIds = [...inRange].filter((id) => id !== UNCATEGORIZED_ID && !named.includes(id));
    series = [
      ...named
        .filter((id) => inRange.has(id))
        .map((id) => ({ id, name: nameOf(id), color: colorOf(id), values: periods.map((p) => valueOf(p.key, id)) })),
      ...(otherIds.length
        ? [
            {
              id: OTHER_ID,
              name: `Other (${otherIds.length})`,
              color: "var(--viz-7)",
              values: periods.map((p) => otherIds.reduce((sum, id) => sum + valueOf(p.key, id), 0)),
            },
          ]
        : []),
      ...(inRange.has(UNCATEGORIZED_ID)
        ? [
            {
              id: UNCATEGORIZED_ID,
              name: "Uncategorized",
              color: colorOf(UNCATEGORIZED_ID),
              values: periods.map((p) => valueOf(p.key, UNCATEGORIZED_ID)),
            },
          ]
        : []),
    ];
  } else {
    series = [{ id: focus, name: nameOf(focus), color: colorOf(focus), values: periods.map((p) => valueOf(p.key, focus)) }];
  }

  const rangeText = monthRangeLabel(months[0]!, months[months.length - 1]!);
  const perMonth = (cents: number) => formatCents(Math.round(cents / months.length));

  return (
    <>
      <header className="page-head">
        <h1>Spending</h1>
        <p className="muted">{rangeText}</p>
      </header>

      <div className="filters filter-row">
        <label>
          Range
          <select value={rangeId} onChange={(e) => setRangeId(e.target.value as typeof rangeId)}>
            {RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Group by
          <select value={grouping} onChange={(e) => setGrouping(e.target.value as typeof grouping)}>
            <option value="month">Month</option>
            <option value="week">Week</option>
          </select>
        </label>
        <label>
          Category
          <select value={focus} onChange={(e) => setFocus(e.target.value === "all" ? "all" : Number(e.target.value))}>
            <option value="all">All categories</option>
            {rows.map(([id]) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="panel">
        <ColumnChart
          title={focus === "all" ? `Spending by category per ${grouping}` : `${nameOf(focus)} per ${grouping}`}
          periods={periods}
          series={series}
          stacked
          capLabels={grouping === "month" && periods.length <= 12}
          height={300}
        />
        <p className="muted chart-note">
          Spending categories net of refunds, plus money out that isn't categorized yet. Transfers and income aren't included.
        </p>
      </section>

      <section className="panel">
        <h2 className="chart-title">By category · {rangeText}</h2>
        <div className="table-scroll">
          <table className="chart-table">
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Total</th>
                <th className="num">Per month</th>
                <th className="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([id, cents]) => (
                <tr key={id} className={focus === id ? "selected" : undefined}>
                  <td>
                    <span className="swatch" style={{ background: colorOf(id) }} aria-hidden="true" />
                    <button type="button" className="link" onClick={() => setFocus(focus === id ? "all" : id)}>
                      {nameOf(id)}
                    </button>
                  </td>
                  <td className="num">{formatCents(cents)}</td>
                  <td className="num">{perMonth(cents)}</td>
                  <td className="num">{grandTotal > 0 ? `${((cents / grandTotal) * 100).toFixed(1)}%` : "–"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="num">{formatCents(grandTotal)}</td>
                <td className="num">{perMonth(grandTotal)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </>
  );
}

function monthsBetween(first: string, last: string): string[] {
  const [y1, m1] = first.split("-").map(Number);
  const [y2, m2] = last.split("-").map(Number);
  return monthsEnding(last, (y2! - y1!) * 12 + (m2! - m1!) + 1);
}
