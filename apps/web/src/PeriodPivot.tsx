import { Fragment, useState } from "react";
import {
  earliestDate,
  latestDate,
  type PeriodSize,
  type PivotSection,
  pivotByCategory,
  spanOf,
  spansBetween,
  spendDate,
  UNCATEGORIZED_ID,
  UNCATEGORIZED_IN_ID,
} from "./analytics";
import type { Category, TransactionRow } from "./api";
import { formatCents, formatDate } from "./format";

interface Props {
  transactions: TransactionRow[];
  categories: Category[];
}

const SIZES: { id: PeriodSize | "custom"; label: string }[] = [
  { id: "month", label: "Month" },
  { id: "quarter", label: "Quarter" },
  { id: "half", label: "Half year" },
  { id: "year", label: "Year" },
  { id: "custom", label: "Custom dates" },
];

const SECTIONS: Record<PivotSection, { title: string; note?: string }> = {
  income: { title: "Income" },
  expense: { title: "Spending" },
  other: { title: "Not counted", note: "Transfers and uncategorized money in, signed like amounts" },
};

/** A pivot of one period by category; each category opens up to the transactions behind it. */
export function PeriodPivot({ transactions, categories }: Props) {
  const first = earliestDate(transactions)!;
  const last = latestDate(transactions)!;

  const [size, setSize] = useState<PeriodSize | "custom">("month");
  const [key, setKey] = useState<string | null>(null);
  const [custom, setCustom] = useState(() => spanOf("month", last));
  const [open, setOpen] = useState<Set<string>>(new Set());

  const spans = size === "custom" ? [] : spansBetween(size, first, last);
  const index = Math.max(
    spans.findIndex((s) => s.key === key),
    0,
  );
  const span = size === "custom" ? custom : spans[index]!;

  const changeSize = (next: PeriodSize | "custom") => {
    // Keep roughly the same place in time: the new period containing the end of the current one.
    const anchor = span.end > last ? last : span.end;
    if (next === "custom") setCustom(span);
    else setKey(spanOf(next, anchor < first ? first : anchor).key);
    setSize(next);
  };

  const groups = pivotByCategory(transactions, categories, span);
  const income = groups.find((g) => g.section === "income")!.total;
  const spending = groups.find((g) => g.section === "expense")!.total;
  const net = income - spending;
  const isEmpty = groups.every((g) => g.categories.length === 0);

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
        <h2>Breakdown by period</h2>
        <div className="filters">
          <label>
            Period
            <select value={size} onChange={(e) => changeSize(e.target.value as typeof size)}>
              {SIZES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          {size === "custom" ? (
            <>
              <label>
                From
                <input
                  type="date"
                  value={custom.start}
                  max={custom.end}
                  onChange={(e) => e.target.value && setCustom({ ...custom, start: e.target.value })}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={custom.end}
                  min={custom.start}
                  onChange={(e) => e.target.value && setCustom({ ...custom, end: e.target.value })}
                />
              </label>
            </>
          ) : (
            <div className="period-stepper">
              <button
                type="button"
                aria-label="Previous period"
                disabled={index >= spans.length - 1}
                onClick={() => setKey(spans[index + 1]!.key)}
              >
                ‹
              </button>
              <label>
                <span className="visually-hidden">Which {size}</span>
                <select value={span.key} onChange={(e) => setKey(e.target.value)}>
                  {spans.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" aria-label="Next period" disabled={index === 0} onClick={() => setKey(spans[index - 1]!.key)}>
                ›
              </button>
            </div>
          )}
        </div>
      </div>

      <p className="muted pivot-summary">
        {formatDate(span.start)} – {formatDate(span.end)}
        {span.end > last && span.start <= last && ` · data through ${formatDate(last)}`}
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
                <th>Date</th>
                <th className="num">Amount</th>
                <th className="num">Share</th>
              </tr>
            </thead>
            {groups
              .filter((g) => g.categories.length > 0)
              .map((g) => (
                <tbody key={g.section}>
                  <tr className="pivot-section">
                    <th scope="rowgroup" colSpan={2}>
                      {SECTIONS[g.section].title}
                      {SECTIONS[g.section].note && <span className="detail"> · {SECTIONS[g.section].note}</span>}
                    </th>
                    <td className="num">{formatCents(g.total)}</td>
                    <td />
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
                          <td className="muted">
                            {c.entries.length} transaction{c.entries.length === 1 ? "" : "s"}
                          </td>
                          <td className="num">{formatCents(c.total)}</td>
                          <td className="num">
                            {g.section !== "other" && g.total > 0 ? `${((c.total / g.total) * 100).toFixed(1)}%` : ""}
                          </td>
                        </tr>
                        {expanded &&
                          c.entries.map((e) => (
                            <tr key={e.transaction.id} className="pivot-entry">
                              <td>
                                <div className="pivot-description">{e.transaction.description}</div>
                                <div className="detail">
                                  {e.transaction.accountName}
                                  {e.partial && ` · part of ${formatCents(Math.round(e.transaction.amount * 100))}`}
                                </div>
                              </td>
                              <td>{formatDate(spendDate(e.transaction))}</td>
                              <td className="num">{formatCents(e.cents)}</td>
                              <td />
                            </tr>
                          ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              ))}
            <tfoot>
              <tr>
                <td colSpan={2}>Net (income − spending)</td>
                <td className={`num ${net > 0 ? "good" : net < 0 ? "bad" : ""}`}>
                  {net > 0 ? "+" : ""}
                  {formatCents(net)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
