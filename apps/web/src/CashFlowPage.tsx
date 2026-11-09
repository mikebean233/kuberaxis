import { useState } from "react";
import {
  amountsByCategory,
  endOfMonth,
  formatDollarsShort,
  type FlowKind,
  latestDate,
  latestMonth,
  monthPeriod,
  monthOf,
  monthRangeLabel,
  monthsEnding,
  rankCategories,
  spendDate,
  totalsByPeriod,
  UNCATEGORIZED_ID,
  weekLabel,
  weekOf,
  weeksBetween,
} from "./analytics";
import type { Category, TransactionRow } from "./api";
import { ColumnChart, type ChartSeries } from "./ColumnChart";
import { formatCents } from "./format";
import { PeriodPivot } from "./PeriodPivot";

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

const BREAKDOWNS: Record<FlowKind, { title: string; note: string }> = {
  expense: {
    title: "Spending",
    note: "Spending categories net of refunds, plus money out that isn't categorized yet.",
  },
  income: {
    title: "Income",
    note: "Income categories net of reversals. Money in without a category isn't included.",
  },
};

type Period = { key: string; label: string; longLabel?: string };

/** Income and spending over time, then each broken down by category. */
export function CashFlowPage({ transactions: allTransactions, categories }: Props) {
  const [rangeId, setRangeId] = useState<(typeof RANGES)[number]["id"]>("6");
  const [grouping, setGrouping] = useState<"month" | "week">("month");
  const [accountId, setAccountId] = useState<number | "all">("all");

  const accounts = [...new Map(allTransactions.map((t) => [t.accountId, t.accountName])).entries()].sort((a, b) =>
    a[1].localeCompare(b[1]),
  );
  // An account that's no longer present (deleted, purged) falls back to all.
  const account = accountId !== "all" && accounts.some(([id]) => id === accountId) ? accountId : "all";
  const transactions = account === "all" ? allTransactions : allTransactions.filter((t) => t.accountId === account);

  const last = latestMonth(transactions);
  if (!last) return <p className="empty">No transactions yet. Import a statement to get started.</p>;

  const range = RANGES.find((r) => r.id === rangeId)!;
  const first =
    range.months === null
      ? monthOf(transactions.reduce((min, t) => (spendDate(t) < min ? spendDate(t) : min), spendDate(transactions[0]!)))
      : null;
  const months = range.months === null ? monthsBetween(first!, last) : monthsEnding(last, range.months);
  const periods: Period[] =
    grouping === "month"
      ? months.map((m) => monthPeriod(m, latestDate(transactions), { initial: months.length > 12 }))
      : weeksBetween(`${months[0]}-01`, endOfMonth(months[months.length - 1]!)).map((w) => ({
          key: w,
          label: weekLabel(w),
          longLabel: `Week of ${weekLabel(w)}`,
        }));
  const periodOf = grouping === "month" ? monthOf : weekOf;
  const rangeText = monthRangeLabel(months[0]!, months[months.length - 1]!);
  const capLabels = grouping === "month" && periods.length <= 12;

  const byPeriod = totalsByPeriod(
    transactions,
    categories,
    periods.map((p) => p.key),
    periodOf,
  );
  const total = { spending: 0, income: 0 };
  for (const t of byPeriod.values()) {
    total.spending += t.spending;
    total.income += t.income;
  }
  // Money out without a category, which the spending breakdown counts.
  const uncategorizedOut = [
    ...amountsByCategory(
      transactions,
      categories,
      "expense",
      periods.map((p) => p.key),
      periodOf,
    ).values(),
  ].reduce((sum, bucket) => sum + (bucket.get(UNCATEGORIZED_ID) ?? 0), 0);
  const net = total.income - total.spending;

  const breakdown = { transactions, categories, periods, periodOf, months: months.length, rangeText, grouping, capLabels };

  return (
    <>
      <header className="page-head">
        <h1>Cash flow</h1>
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
        {accounts.length > 1 && (
          <label>
            Account
            <select value={account} onChange={(e) => setAccountId(e.target.value === "all" ? "all" : Number(e.target.value))}>
              <option value="all">All accounts</option>
              {accounts.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="stat-row">
        <div className="stat-tile">
          <div className="stat-label">Income</div>
          <div className="stat-value">{formatDollarsShort(total.income)}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">Spending</div>
          <div className="stat-value">{formatDollarsShort(total.spending)}</div>
          {uncategorizedOut > 0 && (
            <div className="stat-delta muted">Plus {formatDollarsShort(uncategorizedOut)} of uncategorized money out</div>
          )}
        </div>
        <div className="stat-tile">
          <div className="stat-label">Net</div>
          <div className={`stat-value ${net > 0 ? "good" : net < 0 ? "bad" : ""}`}>
            {net > 0 ? `+${formatDollarsShort(net)}` : formatDollarsShort(net)}
          </div>
          <div className="stat-delta muted">Income minus spending</div>
        </div>
      </div>

      <section className="panel">
        <ColumnChart
          title={`Income and spending per ${grouping}`}
          periods={periods}
          series={[
            { id: "income", name: "Income", color: "var(--viz-2)", values: periods.map((p) => byPeriod.get(p.key)!.income) },
            { id: "spending", name: "Spending", color: "var(--viz-1)", values: periods.map((p) => byPeriod.get(p.key)!.spending) },
          ]}
          capLabels={capLabels && periods.length <= 6}
          height={260}
        />
        <p className="muted chart-note">
          Categorized income and spending. Transfers between your own accounts (credit card payments, investments) and
          uncategorized transactions aren't counted.
        </p>
      </section>

      <CategoryBreakdown kind="expense" {...breakdown} />
      <CategoryBreakdown kind="income" {...breakdown} />
      <PeriodPivot transactions={transactions} categories={categories} />
    </>
  );
}

/** One kind of category over the range: a stacked chart and a table of totals, with a category focus. */
function CategoryBreakdown({
  kind,
  transactions,
  categories,
  periods,
  periodOf,
  months,
  rangeText,
  grouping,
  capLabels,
}: Props & {
  kind: FlowKind;
  periods: Period[];
  periodOf: (iso: string) => string;
  months: number;
  rangeText: string;
  grouping: string;
  capLabels: boolean;
}) {
  const [focus, setFocus] = useState<number | "all">("all");
  const { title, note } = BREAKDOWNS[kind];

  // Colors are assigned by all-time rank, so a category keeps its color whatever the range or filter.
  const named = rankCategories(transactions, categories, kind).slice(0, NAMED_SLOTS);
  const colorOf = (id: number) =>
    id === UNCATEGORIZED_ID ? "var(--viz-neutral)" : named.includes(id) ? `var(--viz-${named.indexOf(id) + 1})` : "var(--viz-7)";
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const nameOf = (id: number) => (id === UNCATEGORIZED_ID ? "Uncategorized" : id === OTHER_ID ? "Other" : (names.get(id) ?? "?"));

  const data = amountsByCategory(
    transactions,
    categories,
    kind,
    periods.map((p) => p.key),
    periodOf,
  );
  const valueOf = (period: string, id: number) => data.get(period)?.get(id) ?? 0;

  const totals = new Map<number, number>();
  for (const bucket of data.values()) for (const [id, cents] of bucket) totals.set(id, (totals.get(id) ?? 0) + cents);
  const rows = [...totals.entries()].filter(([, cents]) => cents !== 0).sort((a, b) => b[1] - a[1]);
  const grandTotal = rows.reduce((sum, [, cents]) => sum + cents, 0);
  // A focused category with nothing in the new range falls back to all.
  const focused = focus !== "all" && totals.has(focus) ? focus : "all";

  let series: ChartSeries[];
  if (focused === "all") {
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
    series = [{ id: focused, name: nameOf(focused), color: colorOf(focused), values: periods.map((p) => valueOf(p.key, focused)) }];
  }

  const perMonth = (cents: number) => formatCents(Math.round(cents / months));

  return (
    <section className="panel">
      <div className="section-head">
        <h2>{title} by category</h2>
        {rows.length > 0 && (
          <div className="filters">
            <label>
              Category
              <select value={focused} onChange={(e) => setFocus(e.target.value === "all" ? "all" : Number(e.target.value))}>
                <option value="all">All categories</option>
                {rows.map(([id]) => (
                  <option key={id} value={id}>
                    {nameOf(id)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="muted">No {title.toLowerCase()} in this range.</p>
      ) : (
        <>
          <ColumnChart
            title={focused === "all" ? `${title} by category per ${grouping}` : `${nameOf(focused)} per ${grouping}`}
            periods={periods}
            series={series}
            stacked
            capLabels={capLabels}
            height={300}
          />
          <p className="muted chart-note">{note}</p>

          <h3 className="chart-title">
            {title} totals · {rangeText}
          </h3>
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
                  <tr key={id} className={focused === id ? "selected" : undefined}>
                    <td>
                      <span className="swatch" style={{ background: colorOf(id) }} aria-hidden="true" />
                      <button type="button" className="link" onClick={() => setFocus(focused === id ? "all" : id)}>
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
        </>
      )}
    </section>
  );
}

function monthsBetween(first: string, last: string): string[] {
  const [y1, m1] = first.split("-").map(Number);
  const [y2, m2] = last.split("-").map(Number);
  return monthsEnding(last, (y2! - y1!) * 12 + (m2! - m1!) + 1);
}
