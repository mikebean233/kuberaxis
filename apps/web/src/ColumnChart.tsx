import { useEffect, useId, useRef, useState } from "react";
import { formatDollarsShort, niceTicks } from "./analytics";
import { formatCents } from "./format";

export interface ChartSeries {
  id: string | number;
  name: string;
  /** A CSS color, normally one of the --viz-* tokens. */
  color: string;
  /** Cents per period, in the same order as `periods`. */
  values: number[];
  /** With `stacked`, series sharing a stack name stack into one column; each stack gets its own column, side by side. */
  stack?: string;
}

interface Props {
  title: string;
  periods: { key: string; label: string; longLabel?: string }[];
  series: ChartSeries[];
  /** Stack the series into one column per period (one per `stack`, if they're named) instead of side by side. */
  stacked?: boolean;
  /** Print values on column caps (each bar when grouped, the total when stacked). Off for dense charts. */
  capLabels?: boolean;
  height?: number;
}

const MARGIN = { top: 22, right: 8, bottom: 28, left: 56 };
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

/** Column chart with one baseline, a hairline grid, a tooltip per period and a table view. */
export function ColumnChart({ title, periods, series, stacked = false, capLabels = false, height = 260 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const id = useId();

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const plotWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  // Negative net values (refunds exceeding spending) draw as nothing; the tooltip and table show them.
  const clamp = (v: number) => Math.max(v, 0);
  const stacks = stacked ? stacksOf(series) : [];
  // Per stack, per period: what the column's height adds up to.
  const stackTotals = stacks.map((st) => periods.map((_, i) => st.series.reduce((sum, s) => sum + clamp(s.values[i] ?? 0), 0)));
  const max = stacked ? Math.max(0, ...stackTotals.flat()) : Math.max(0, ...series.flatMap((s) => s.values.map(clamp)));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const y = (v: number) => plotHeight - (clamp(v) / top) * plotHeight;

  const band = periods.length ? plotWidth / periods.length : 0;
  const groupCount = stacked ? stacks.length : series.length;
  const barWidth = Math.max(Math.min(MAX_BAR, (band * 0.7 - GAP * (groupCount - 1)) / groupCount), 2);
  const groupWidth = barWidth * groupCount + GAP * (groupCount - 1);
  // Skip x labels when they'd collide.
  const labelEvery = Math.max(1, Math.ceil(52 / Math.max(band, 1)));

  const tooltipLeft = active === null ? 0 : MARGIN.left + band * (active + 0.5);

  return (
    <figure className="chart" aria-labelledby={`${id}-title`}>
      <figcaption className="chart-head">
        <span id={`${id}-title`} className="chart-title">
          {title}
        </span>
        {stacks.length > 1 ? (
          <div className="chart-legends">
            {stacks.map((st) => (
              <Legend key={st.name} label={st.name} series={st.series} />
            ))}
          </div>
        ) : (
          series.length > 1 && <Legend series={series} />
        )}
      </figcaption>

      <div ref={containerRef} className="chart-plot" style={{ height }} onPointerLeave={() => setActive(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`${title}. Values are in the table view.`}>
            <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
              {ticks.map((t) => (
                <g key={t} transform={`translate(0,${y(t)})`}>
                  <line x2={plotWidth} className={t === 0 ? "chart-baseline" : "chart-grid"} />
                  <text x={-8} dy="0.32em" textAnchor="end" className="chart-tick">
                    {formatDollarsShort(t)}
                  </text>
                </g>
              ))}

              {periods.map((p, i) => {
                const x0 = band * i + (band - groupWidth) / 2;
                return (
                  <g key={p.key} className={active !== null && active !== i ? "chart-dim" : undefined}>
                    {active === i && <rect x={band * i} width={band} height={plotHeight} className="chart-hover-band" />}
                    {stacked
                      ? stacks.map((st, k) => {
                          const x = x0 + k * (barWidth + GAP);
                          const visible = st.series.filter((s) => clamp(s.values[i] ?? 0) > 0);
                          let stackTop = plotHeight;
                          return visible.map((s) => {
                            const h = (clamp(s.values[i] ?? 0) / top) * plotHeight;
                            const isTop = visible[visible.length - 1] === s;
                            // A surface-colored gap separates stacked segments.
                            const drawn = Math.max(h - (stackTop < plotHeight ? GAP : 0), 0.5);
                            stackTop -= h;
                            return <path key={s.id} d={column(x, stackTop + (h - drawn), barWidth, drawn, isTop)} fill={s.color} />;
                          });
                        })
                      : series.map((s, j) => {
                          const value = clamp(s.values[i] ?? 0);
                          if (value <= 0) return null;
                          const x = x0 + j * (barWidth + GAP);
                          return <path key={s.id} d={column(x, y(value), barWidth, plotHeight - y(value), true)} fill={s.color} />;
                        })}
                    {capLabels &&
                      (stacked
                        ? stacks.map((st, k) => {
                            const total = stackTotals[k]![i]!;
                            return total > 0 ? (
                              <text
                                key={st.name}
                                x={x0 + k * (barWidth + GAP) + barWidth / 2}
                                y={y(total) - 6}
                                textAnchor="middle"
                                className="chart-cap"
                              >
                                {formatDollarsShort(total)}
                              </text>
                            ) : null;
                          })
                        : series.map((s, j) => {
                            const value = s.values[i] ?? 0;
                            // Values that would print as "$0" get no cap label; the tooltip and table still have them.
                            return value >= 50 ? (
                              <text
                                key={s.id}
                                x={x0 + j * (barWidth + GAP) + barWidth / 2}
                                y={y(value) - 6}
                                textAnchor="middle"
                                className="chart-cap"
                              >
                                {formatDollarsShort(value)}
                              </text>
                            ) : null;
                          }))}
                    {i % labelEvery === 0 && (
                      <text x={band * i + band / 2} y={plotHeight + 18} textAnchor="middle" className="chart-tick">
                        {p.label}
                      </text>
                    )}
                    {/* The whole period band is the hit target. */}
                    <rect
                      x={band * i}
                      width={band}
                      height={plotHeight}
                      fill="transparent"
                      tabIndex={0}
                      aria-label={`${p.longLabel ?? p.label}: ${series.map((s) => `${s.name} ${formatCents(s.values[i] ?? 0)}`).join(", ")}`}
                      onPointerEnter={() => setActive(i)}
                      onFocus={() => setActive(i)}
                      onBlur={() => setActive(null)}
                    />
                  </g>
                );
              })}
            </g>
          </svg>
        )}

        {active !== null && periods[active] && (
          <div
            className="chart-tooltip"
            role="status"
            style={{ left: tooltipLeft, transform: `translateX(${tooltipLeft > width / 2 ? "calc(-100% - 12px)" : "12px"})` }}
          >
            <div className="chart-tooltip-title">{periods[active]!.longLabel ?? periods[active]!.label}</div>
            {(stacked ? stacks : [{ name: "", series }]).map((st) => (
              <div key={st.name} className="chart-tooltip-group">
                {/* Top of the stack first, as drawn. */}
                {[...st.series].reverse().map((s) => (
                  <div key={s.id} className="chart-tooltip-row">
                    <span className="line-key" style={{ background: s.color }} aria-hidden="true" />
                    <strong>{formatCents(s.values[active] ?? 0)}</strong>
                    <span>{s.name}</span>
                  </div>
                ))}
                {stacked && (st.series.length > 1 || stacks.length > 1) && (
                  <div className="chart-tooltip-row total">
                    <span className="line-key" aria-hidden="true" />
                    <strong>{formatCents(st.series.reduce((sum, s) => sum + (s.values[active] ?? 0), 0))}</strong>
                    <span>{st.name ? `${st.name} total` : "Total"}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <button type="button" className="link chart-table-toggle" aria-expanded={showTable} onClick={() => setShowTable((v) => !v)}>
        {showTable ? "Hide table" : "Show table"}
      </button>
      {showTable && <ChartTable periods={periods} series={series} stacked={stacked} />}
    </figure>
  );
}

function Legend({ label, series }: { label?: string; series: ChartSeries[] }) {
  return (
    <ul className="chart-legend">
      {label && <li className="chart-legend-label">{label}</li>}
      {series.map((s) => (
        <li key={s.id}>
          <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
          {s.name}
        </li>
      ))}
    </ul>
  );
}

/** Series grouped by stack name, in first-seen order; unnamed series share one stack. */
function stacksOf(series: ChartSeries[]): { name: string; series: ChartSeries[] }[] {
  const stacks = new Map<string, ChartSeries[]>();
  for (const s of series) stacks.set(s.stack ?? "", [...(stacks.get(s.stack ?? "") ?? []), s]);
  return [...stacks].map(([name, members]) => ({ name, series: members }));
}

function ChartTable({ periods, series, stacked }: Pick<Props, "periods" | "series" | "stacked">) {
  // Stacked: each stack's series, then its total when there's more than one.
  const columns = (stacked ? stacksOf(series) : [{ name: "", series }]).flatMap((st) => [
    ...st.series.map((s) => ({ key: String(s.id), name: s.name, value: (i: number) => s.values[i] ?? 0 })),
    ...(stacked && st.series.length > 1
      ? [
          {
            key: `total:${st.name}`,
            name: st.name ? `${st.name} total` : "Total",
            value: (i: number) => st.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
          },
        ]
      : []),
  ]);
  return (
    <div className="table-scroll">
      <table className="chart-table">
        <thead>
          <tr>
            <th>Period</th>
            {columns.map((c) => (
              <th key={c.key} className="num">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {periods.map((p, i) => (
            <tr key={p.key}>
              <td>{p.longLabel ?? p.label}</td>
              {columns.map((c) => (
                <td key={c.key} className="num">
                  {formatCents(c.value(i))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A column from the baseline up, with rounded top corners when it's the data end. */
function column(x: number, top: number, w: number, h: number, roundTop: boolean): string {
  const r = roundTop ? Math.min(RADIUS, w / 2, h) : 0;
  const bottom = top + h;
  return [
    `M${x},${bottom}`,
    `V${top + r}`,
    r ? `Q${x},${top} ${x + r},${top}` : "",
    `H${x + w - r}`,
    r ? `Q${x + w},${top} ${x + w},${top + r}` : "",
    `V${bottom}`,
    "Z",
  ].join(" ");
}
