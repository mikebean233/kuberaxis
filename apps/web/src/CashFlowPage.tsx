import { useState } from "react";
import {
  amountsByCategory,
  earliestDate,
  formatDollarsShort,
  type FlowKind,
  latestDate,
  monthPeriod,
  monthOf,
  monthsEnding,
  rankCategories,
  spendDate,
  totalsByPeriod,
  UNCATEGORIZED_ID,
  weekLabel,
  weekOf,
  weeksBetween,
} from "./analytics";
import type { Account, Category, TransactionRow } from "./api";
import { ColumnChart, type ChartSeries } from "./ColumnChart";
import { formatDate } from "./format";
import { DEFAULT_PERIOD, PeriodPicker, type PeriodState, resolvePeriod } from "./PeriodPicker";
import { MultiSelect } from "./MultiSelect";
import { PeriodPivot } from "./PeriodPivot";

interface Props {
  transactions: TransactionRow[];
  categories: Category[];
}

/** Categories that get their own color, shared by both kinds; the rest of each kind folds into "Other". */
const NAMED_SLOTS = 6;
/** At most this many of the named slots go to income, which usually has few categories. */
const INCOME_SLOTS = 2;
const OTHER_ID = -2;

/** Spending's column sits left of income's in each period. */
const KINDS: { kind: FlowKind; title: string }[] = [
  { kind: "expense", title: "Spending" },
  { kind: "income", title: "Income" },
];

type Period = { key: string; label: string; longLabel?: string };

/** Income and spending over the period, broken down by category, then the transactions behind them. */
export function CashFlowPage({ transactions: allTransactions, categories, accounts: accountList }: Props & { accounts: Account[] }) {
  const [period, setPeriod] = useState<PeriodState>(DEFAULT_PERIOD);
  const [grouping, setGrouping] = useState<"month" | "week">("month");
  const [accountId, setAccountId] = useState<number | "all">("all");

  const accounts = [...new Map(allTransactions.map((t) => [t.accountId, t.accountName])).entries()].sort((a, b) =>
    a[1].localeCompare(b[1]),
  );
  // An account that's no longer present (deleted, purged) falls back to all.
  const account = accountId !== "all" && accounts.some(([id]) => id === accountId) ? accountId : "all";
  const transactions = account === "all" ? allTransactions : allTransactions.filter((t) => t.accountId === account);

  const first = earliestDate(transactions);
  const last = latestDate(transactions);
  if (!first || !last) return <p className="empty">No transactions yet. Import a statement to get started.</p>;

  // One span of dates drives every section below.
  const { span, size, label: rangeText } = resolvePeriod(period, first, last);
  const inSpan = transactions.filter((t) => spendDate(t) >= span.start && spendDate(t) <= span.end);
  const months = monthsBetween(monthOf(span.start), monthOf(span.end));
  const periods: Period[] =
    grouping === "month"
      ? months.map((m) => monthPeriod(m, last, { initial: months.length > 12 }))
      : weeksBetween(span.start, span.end).map((w) => ({
          key: w,
          label: weekLabel(w),
          longLabel: `Week of ${weekLabel(w)}`,
        }));
  const periodOf = grouping === "month" ? monthOf : weekOf;
  const capLabels = grouping === "month" && periods.length <= 12;

  const byPeriod = totalsByPeriod(
    inSpan,
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
      inSpan,
      categories,
      "expense",
      periods.map((p) => p.key),
      periodOf,
    ).values(),
  ].reduce((sum, bucket) => sum + (bucket.get(UNCATEGORIZED_ID) ?? 0), 0);
  const net = total.income - total.spending;

  const breakdown = {
    transactions: inSpan,
    rankFrom: transactions,
    categories,
    periods,
    periodOf,
    grouping,
    capLabels,
  };

  return (
    <>
      <header className="page-head">
        <h1>Cash flow</h1>
        <p className="muted">
          {rangeText}
          {span.end > last && span.start <= last && ` · data through ${formatDate(last)}`}
        </p>
      </header>

      <div className="filters filter-row">
        <PeriodPicker state={period} onChange={setPeriod} first={first} last={last} />
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

      <CategoryBreakdown {...breakdown} />
      <PeriodPivot
        transactions={inSpan}
        categories={categories}
        span={span}
        size={size}
        dataRanges={new Map(accountList.map((a) => [a.id, { firstDate: a.firstDate, lastDate: a.lastDate }]))}
      />
    </>
  );
}

/** Spending and income by category in one chart: a stacked column of each per period, narrowed to chosen categories. */
function CategoryBreakdown({
  transactions,
  rankFrom,
  categories,
  periods,
  periodOf,
  grouping,
  capLabels,
}: Props & {
  /** All transactions (not just this range), so category colors stay put as the range changes. */
  rankFrom: TransactionRow[];
  periods: Period[];
  periodOf: (iso: string) => string;
  grouping: string;
  capLabels: boolean;
}) {
  // Keys like "expense:12". Kept when the range changes, so a category with nothing in this range comes back after.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Colors are assigned by all-time rank, so a category keeps its color whatever the range or filter. Both kinds
  // share one chart, so they split the palette instead of each starting at the first color.
  const rankedIncome = rankCategories(rankFrom, categories, "income");
  const incomeSlots = Math.min(INCOME_SLOTS, rankedIncome.length);
  const named: Record<FlowKind, number[]> = {
    expense: rankCategories(rankFrom, categories, "expense").slice(0, NAMED_SLOTS - incomeSlots),
    income: rankedIncome.slice(0, incomeSlots),
  };
  const slotOf = (kind: FlowKind, id: number) => {
    const index = named[kind].indexOf(id);
    return index === -1 ? null : (kind === "income" ? NAMED_SLOTS - incomeSlots : 0) + index + 1;
  };
  const colorOf = (kind: FlowKind, id: number) => {
    if (id === UNCATEGORIZED_ID) return "var(--viz-neutral)";
    const slot = slotOf(kind, id);
    return slot === null ? "var(--viz-7)" : `var(--viz-${slot})`;
  };
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const nameOf = (id: number) => (id === UNCATEGORIZED_ID ? "Uncategorized" : (names.get(id) ?? "?"));
  const keyOf = (kind: FlowKind, id: number) => `${kind}:${id}`;

  const kinds = KINDS.map(({ kind, title }) => {
    const data = amountsByCategory(
      transactions,
      categories,
      kind,
      periods.map((p) => p.key),
      periodOf,
    );
    const totals = new Map<number, number>();
    for (const bucket of data.values()) for (const [id, cents] of bucket) totals.set(id, (totals.get(id) ?? 0) + cents);
    // Largest first; what's in range is what can be picked.
    const ids = [...totals.entries()]
      .filter(([, cents]) => cents !== 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    return { kind, title, ids, valueOf: (period: string, id: number) => data.get(period)?.get(id) ?? 0 };
  });
  // Only chosen categories with something in this range count; none of those means all.
  const chosen = kinds.flatMap((k) => k.ids.filter((id) => selected.has(keyOf(k.kind, id))).map((id) => ({ k, id })));

  const seriesOf = (k: (typeof kinds)[number], ids: number[], name: string, color: string, id: string | number): ChartSeries => ({
    id,
    name,
    color,
    stack: k.title,
    values: periods.map((p) => ids.reduce((sum, i) => sum + k.valueOf(p.key, i), 0)),
  });
  const one = (k: (typeof kinds)[number], id: number, color = colorOf(k.kind, id)) =>
    seriesOf(k, [id], nameOf(id), color, keyOf(k.kind, id));
  const other = (k: (typeof kinds)[number], ids: number[]) =>
    seriesOf(k, ids, `Other ${k.title.toLowerCase()} (${ids.length})`, "var(--viz-7)", keyOf(k.kind, OTHER_ID));

  let series: ChartSeries[];
  if (chosen.length === 0) {
    series = kinds.flatMap((k) => {
      const otherIds = k.ids.filter((id) => id !== UNCATEGORIZED_ID && slotOf(k.kind, id) === null);
      return [
        ...named[k.kind].filter((id) => k.ids.includes(id)).map((id) => one(k, id)),
        ...(otherIds.length ? [other(k, otherIds)] : []),
        ...(k.ids.includes(UNCATEGORIZED_ID) ? [one(k, UNCATEGORIZED_ID)] : []),
      ];
    });
  } else {
    // Chosen categories that would be "Other" get their own color from the slots no chosen category is using,
    // so each one can be told apart; any past that fold into "Other" as usual.
    const used = new Set(chosen.map(({ k, id }) => slotOf(k.kind, id)));
    const free = Array.from({ length: NAMED_SLOTS }, (_, i) => i + 1).filter((slot) => !used.has(slot));
    series = kinds.flatMap((k) => {
      const mine = chosen.filter((c) => c.k === k).map((c) => c.id);
      const unslotted = mine.filter((id) => id !== UNCATEGORIZED_ID && slotOf(k.kind, id) === null);
      const extra = unslotted.slice(0, free.length);
      const overflow = unslotted.slice(extra.length);
      const colored = new Map(extra.map((id) => [id, `var(--viz-${free.shift()!})`]));
      return [
        ...mine.filter((id) => id !== UNCATEGORIZED_ID && !overflow.includes(id)).map((id) => one(k, id, colored.get(id))),
        ...(overflow.length ? [other(k, overflow)] : []),
        ...(mine.includes(UNCATEGORIZED_ID) ? [one(k, UNCATEGORIZED_ID)] : []),
      ];
    });
  }

  const hasAny = kinds.some((k) => k.ids.length > 0);
  const title =
    chosen.length === 1
      ? `${nameOf(chosen[0]!.id)} per ${grouping}`
      : chosen.length > 1
        ? `Selected categories per ${grouping}`
        : `Spending (left) and income (right) by category per ${grouping}`;

  return (
    <section className="panel">
      <div className="section-head">
        <h2>Spending and income by category</h2>
        {hasAny && (
          <div className="filters">
            <MultiSelect
              label="Categories"
              allLabel="All categories"
              groups={kinds.map((k) => ({
                label: k.title,
                options: k.ids.map((id) => ({ value: keyOf(k.kind, id), label: nameOf(id), color: colorOf(k.kind, id) })),
              }))}
              selected={new Set(chosen.map(({ k, id }) => keyOf(k.kind, id)))}
              onChange={setSelected}
            />
          </div>
        )}
      </div>

      {!hasAny ? (
        <p className="muted">No spending or income in this range.</p>
      ) : (
        <>
          <ColumnChart title={title} periods={periods} series={series} stacked capLabels={capLabels && periods.length <= 6} height={320} />
          <p className="muted chart-note">
            Spending is spending categories net of refunds, plus money out that isn't categorized yet (gray). Income is
            income categories net of reversals. Transfers between your own accounts (credit card payments, investments)
            and uncategorized money in aren't counted.
          </p>
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
