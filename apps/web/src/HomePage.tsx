import {
  formatDollarsShort,
  latestDate,
  latestMonth,
  monthPeriod,
  monthLabel,
  monthOf,
  monthRangeLabel,
  monthsEnding,
  spendDate,
  spendingByCategory,
  totalsByPeriod,
  UNCATEGORIZED_ID,
  type KindTotals,
} from "./analytics";
import type { Category, TransactionRow } from "./api";
import { ColumnChart } from "./ColumnChart";

interface Props {
  transactions: TransactionRow[];
  categories: Category[];
  onNavigate: (tab: "transactions" | "rules" | "import") => void;
}

const MONTHS = 3;

/** Landing page: spending and income over the last three months with data. */
export function HomePage({ transactions, categories, onNavigate }: Props) {
  const last = latestMonth(transactions);
  if (!last) {
    return (
      <section className="panel empty-state">
        <h2>Welcome to Kuberaxis</h2>
        <p className="muted">Import a bank statement to see where your money goes.</p>
        <button type="button" className="primary" onClick={() => onNavigate("import")}>
          Import a statement
        </button>
      </section>
    );
  }

  // Six months: the three shown plus the three before, for comparison.
  const months = monthsEnding(last, MONTHS * 2);
  const recent = months.slice(MONTHS);
  const byMonth = totalsByPeriod(transactions, categories, months, monthOf);
  const sum = (keys: string[]) =>
    keys.reduce<KindTotals>(
      (acc, m) => {
        const t = byMonth.get(m)!;
        return { spending: acc.spending + t.spending, income: acc.income + t.income, uncategorized: acc.uncategorized + t.uncategorized };
      },
      { spending: 0, income: 0, uncategorized: 0 },
    );
  const current = sum(recent);
  const previous = sum(months.slice(0, MONTHS));
  const hasPrevious = transactions.some((t) => spendDate(t) < `${recent[0]}-01`);

  const recentSet = new Set(recent);
  const uncategorized = transactions.filter(
    (t) => recentSet.has(monthOf(spendDate(t))) && t.allocations.every((a) => a.categoryId === null),
  );
  // Money out without a category: the same measure the spending breakdowns use.
  let uncategorizedOut = 0;
  for (const bucket of spendingByCategory(transactions, categories, recent, monthOf).values()) {
    uncategorizedOut += bucket.get(UNCATEGORIZED_ID) ?? 0;
  }

  const periods = recent.map((m) => monthPeriod(m, latestDate(transactions)));
  const partial = periods[periods.length - 1]!;
  const range = monthRangeLabel(recent[0]!, recent[recent.length - 1]!);

  return (
    <>
      <header className="page-head">
        <h1>Home</h1>
        <p className="muted">
          {range}
          {partial.partialThrough !== null && ` · ${monthLabel(partial.key)} through the ${ordinal(partial.partialThrough)}, so far`}
        </p>
      </header>

      <div className="stat-row">
        <StatTile label="Spending" value={current.spending} previous={hasPrevious ? previous.spending : null} upIsGood={false} />
        <StatTile label="Income" value={current.income} previous={hasPrevious ? previous.income : null} upIsGood />
        <StatTile
          label="Net"
          value={current.income - current.spending}
          previous={hasPrevious ? previous.income - previous.spending : null}
          upIsGood
          signed
        />
        <div className="stat-tile">
          <div className="stat-label">Uncategorized</div>
          <div className="stat-value">{uncategorized.length}</div>
          <div className="stat-delta muted">
            {uncategorized.length === 0 ? (
              "Everything is categorized"
            ) : (
              <>
                {formatDollarsShort(uncategorizedOut)} of money out not counted above ·{" "}
                <button type="button" className="link" onClick={() => onNavigate("transactions")}>
                  Review
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <section className="panel">
        <ColumnChart
          title="Spending and income by month"
          periods={periods}
          series={[
            { id: "spending", name: "Spending", color: "var(--viz-1)", values: recent.map((m) => byMonth.get(m)!.spending) },
            { id: "income", name: "Income", color: "var(--viz-2)", values: recent.map((m) => byMonth.get(m)!.income) },
          ]}
          capLabels
        />
        <p className="muted chart-note">
          Transfers between your own accounts (credit card payments, investments) aren't counted.
          {partial.partialThrough !== null &&
            ` ${monthLabel(partial.key, true)} only has data through the ${ordinal(partial.partialThrough)}, which also lowers the comparison with the previous 3 months.`}
        </p>
      </section>

      <section className="panel">
        <TopCategories transactions={transactions} categories={categories} months={recent} range={range} />
      </section>
    </>
  );
}

const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

function StatTile({
  label,
  value,
  previous,
  upIsGood,
  signed = false,
}: {
  label: string;
  value: number;
  previous: number | null;
  upIsGood: boolean;
  signed?: boolean;
}) {
  const change = previous === null ? null : value - previous;
  const percent = previous ? Math.round((Math.abs(change!) / Math.abs(previous)) * 100) : null;
  const good = change !== null && change !== 0 && change > 0 === upIsGood;
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{signed && value > 0 ? `+${formatDollarsShort(value)}` : formatDollarsShort(value)}</div>
      {change !== null && (
        <div className={`stat-delta ${change === 0 ? "muted" : good ? "good" : "bad"}`}>
          <span aria-hidden="true">{change > 0 ? "▲" : change < 0 ? "▼" : "–"}</span> {change > 0 ? "+" : change < 0 ? "−" : ""}
          {formatDollarsShort(Math.abs(change))}
          {percent !== null && change !== 0 && ` (${percent}%)`} <span className="muted">vs previous 3 months</span>
        </div>
      )}
    </div>
  );
}

/** Ranked bars of the biggest spending categories in the months shown. */
function TopCategories({
  transactions,
  categories,
  months,
  range,
}: {
  transactions: TransactionRow[];
  categories: Category[];
  months: string[];
  range: string;
}) {
  const byMonth = spendingByCategory(transactions, categories, months, monthOf);
  const totals = new Map<number, number>();
  for (const bucket of byMonth.values()) for (const [id, cents] of bucket) totals.set(id, (totals.get(id) ?? 0) + cents);
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const rows = [...totals.entries()]
    .filter(([, cents]) => cents > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, cents]) => ({ id, name: names.get(id) ?? "Uncategorized", cents }));
  const max = rows[0]?.cents ?? 1;

  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <span className="chart-title">Top spending categories · {range}</span>
      </figcaption>
      {rows.length === 0 ? (
        <p className="muted">No categorized spending in these months yet.</p>
      ) : (
        <ol className="hbar-list">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="hbar-name">{r.name}</span>
              <span className="hbar-track">
                <span className={`hbar${r.id < 0 ? " neutral" : ""}`} style={{ width: `${(r.cents / max) * 100}%` }} />
                <span className="hbar-value">{formatDollarsShort(r.cents)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </figure>
  );
}
