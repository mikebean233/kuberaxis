import { Fragment, useState } from "react";
import {
  type DataRange,
  type DateSpan,
  hasUnitOfData,
  minCoveredDays,
  type PeriodSize,
  perDay,
  type PivotEntry,
  type PivotSection,
  pivotByCategory,
  RATE_UNITS,
  rateUnitApplies,
  spendDate,
  UNCATEGORIZED_ID,
  UNCATEGORIZED_IN_ID,
} from "./analytics";
import type { Category, TransactionRow } from "./api";
import { formatCents, formatDate } from "./format";

interface Props {
  transactions: TransactionRow[];
  categories: Category[];
  /** The page's period; the pivot covers exactly these dates. */
  span: DateSpan;
  /** The calendar size the period matches, if any; per-unit columns only show units shorter than it. */
  size: PeriodSize | null;
  /** Each account's first and last transaction dates, which per-unit averages are prorated to. */
  dataRanges: Map<number, DataRange>;
}

const SECTIONS: Record<PivotSection, { title: string; note?: string }> = {
  income: { title: "Income" },
  expense: { title: "Spending" },
  other: { title: "Not counted", note: "Transfers and uncategorized money in, signed like amounts" },
};

/** The page's period by category; each category opens up to the transactions behind it. */
export function PeriodPivot({ transactions, categories, span, size, dataRanges }: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  const groups = pivotByCategory(transactions, categories, span);
  const income = groups.find((g) => g.section === "income")!.total;
  const spending = groups.find((g) => g.section === "expense")!.total;
  const net = income - spending;
  const isEmpty = groups.every((g) => g.categories.length === 0);

  // Per-unit averages: each account prorated over the part of the period it has data for. "–" for units as long as
  // the period or longer, and for units longer than the data a row's accounts have in the period.
  const units = RATE_UNITS.map((u) => ({ ...u, applies: rateUnitApplies(u.id, size, span) }));
  const partsOf = (entries: PivotEntry[]) => entries.map((e) => ({ accountId: e.transaction.accountId, cents: e.cents }));
  const rateOf = (entries: PivotEntry[]) => ({
    perDay: perDay(partsOf(entries), span, dataRanges),
    days: minCoveredDays(partsOf(entries), span, dataRanges),
  });
  const entriesOf = (section: PivotSection) => groups.find((g) => g.section === section)!.categories.flatMap((c) => c.entries);
  const rateCells = (rate: { perDay: number; days: number } | null, className = "") =>
    units.map((u) => {
      const short = rate !== null && u.applies && !hasUnitOfData(rate.days, u);
      return (
        <td
          key={u.id}
          className={`num ${className}`}
          title={short ? `Only ${rate.days} day${rate.days === 1 ? "" : "s"} of data in this period` : undefined}
        >
          {rate === null ? "" : u.applies && !short ? formatCents(Math.round(rate.perDay * u.days)) : "–"}
        </td>
      );
    });
  const netRate = (() => {
    const income = rateOf(entriesOf("income"));
    const spending = rateOf(entriesOf("expense"));
    return { perDay: income.perDay - spending.perDay, days: Math.min(income.days, spending.days) };
  })();

  const names = new Map(categories.map((c) => [c.id, c.name]));
  const nameOf = (id: number) =>
    id === UNCATEGORIZED_ID ? "Uncategorized" : id === UNCATEGORIZED_IN_ID ? "Uncategorized money in" : (names.get(id) ?? "?");
  const rowKey = (section: PivotSection, id: number) => `${section}:${id}`;
  const allKeys = groups.flatMap((g) => g.categories.map((c) => rowKey(g.section, c.id)));
  const allOpen = allKeys.length > 0 && allKeys.every((k) => open.has(k));
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(k)) next.add(k);
      return next;
    });

  return (
    <section className="panel">
      <div className="section-head">
        <h2>Transactions by category</h2>
      </div>

      <p className="muted pivot-summary">
        {formatDate(span.start)} – {formatDate(span.end)}
        {!isEmpty && (
          <>
            {" · "}
            <button type="button" className="link" onClick={() => setOpen(allOpen ? new Set() : new Set(allKeys))}>
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          </>
        )}
      </p>

      {isEmpty ? (
        <p className="muted">No transactions in this period.</p>
      ) : (
        <div className="table-scroll">
          <table className="chart-table pivot">
            <thead>
              <tr>
                <th>Category</th>
                <th>Account</th>
                <th>Date</th>
                <th className="num">Amount</th>
                <th className="num">Share</th>
                {units.map((u) => (
                  <th key={u.id} className="num">
                    {u.label}
                  </th>
                ))}
              </tr>
            </thead>
            {groups
              .filter((g) => g.categories.length > 0)
              .map((g) => (
                <tbody key={g.section}>
                  <tr className="pivot-section">
                    <th scope="rowgroup" colSpan={3}>
                      {SECTIONS[g.section].title}
                      {SECTIONS[g.section].note && <span className="detail"> · {SECTIONS[g.section].note}</span>}
                    </th>
                    <td className="num">{formatCents(g.total)}</td>
                    <td />
                    {rateCells(rateOf(entriesOf(g.section)))}
                  </tr>
                  {g.categories.map((c) => {
                    const k = rowKey(g.section, c.id);
                    const expanded = open.has(k);
                    return (
                      <Fragment key={k}>
                        <tr className="pivot-category">
                          <td>
                            <button type="button" className="disclosure" aria-expanded={expanded} onClick={() => toggle(k)}>
                              <span className="chevron" aria-hidden="true">
                                ▸
                              </span>
                              {nameOf(c.id)}
                            </button>
                          </td>
                          <td className="muted" colSpan={2}>
                            {c.entries.length} transaction{c.entries.length === 1 ? "" : "s"}
                          </td>
                          <td className="num">{formatCents(c.total)}</td>
                          <td className="num">
                            {g.section !== "other" && g.total > 0 ? `${((c.total / g.total) * 100).toFixed(1)}%` : ""}
                          </td>
                          {rateCells(rateOf(c.entries))}
                        </tr>
                        {expanded &&
                          c.entries.map((e) => (
                            <tr key={e.transaction.id} className="pivot-entry">
                              <td>
                                <div className="pivot-description">{e.transaction.description}</div>
                                {e.transaction.details.map((detail, i) => (
                                  <div key={i} className="detail">
                                    {detail}
                                  </div>
                                ))}
                                {e.partial && (
                                  <div className="detail">Part of {formatCents(Math.round(e.transaction.amount * 100))}</div>
                                )}
                              </td>
                              <td>{e.transaction.accountName}</td>
                              <td>{formatDate(spendDate(e.transaction))}</td>
                              <td className="num">{formatCents(e.cents)}</td>
                              <td />
                              {rateCells(null)}
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              ))}
            <tfoot>
              <tr>
                <td colSpan={3}>Net (income − spending)</td>
                <td className={`num ${net > 0 ? "good" : net < 0 ? "bad" : ""}`}>
                  {net > 0 ? "+" : ""}
                  {formatCents(net)}
                </td>
                <td />
                {rateCells(netRate, netRate.perDay > 0 ? "good" : netRate.perDay < 0 ? "bad" : "")}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
