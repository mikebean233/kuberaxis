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
}

interface Props {
  title: string;
  periods: { key: string; label: string; longLabel?: string }[];
  series: ChartSeries[];
  /** Stack the series into one column per period instead of grouping them side by side. */
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
  const totals = periods.map((_, i) => series.reduce((sum, s) => sum + clamp(s.values[i] ?? 0), 0));
  const max = stacked ? Math.max(0, ...totals) : Math.max(0, ...series.flatMap((s) => s.values.map(clamp)));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const y = (v: number) => plotHeight - (clamp(v) / top) * plotHeight;

  const band = periods.length ? plotWidth / periods.length : 0;
  const groupCount = stacked ? 1 : series.length;
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
        {series.length > 1 && (
          <ul className="chart-legend">
            {series.map((s) => (
              <li key={s.id}>
                <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
                {s.name}
              </li>
            ))}
          </ul>
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
                let stackTop = plotHeight;
                const visible = series.filter((s) => clamp(s.values[i] ?? 0) > 0);
                return (
                  <g key={p.key} className={active !== null && active !== i ? "chart-dim" : undefined}>
                    {active === i && <rect x={band * i} width={band} height={plotHeight} className="chart-hover-band" />}
                    {series.map((s, j) => {
                      const value = clamp(s.values[i] ?? 0);
                      if (value <= 0) return null;
                      if (!stacked) {
                        const x = x0 + j * (barWidth + GAP);
                        return <path key={s.id} d={column(x, y(value), barWidth, plotHeight - y(value), true)} fill={s.color} />;
                      }
                      const h = (value / top) * plotHeight;
                      const isTop = visible[visible.length - 1] === s;
                      // A surface-colored gap separates stacked segments.
                      const drawn = Math.max(h - (stackTop < plotHeight ? GAP : 0), 0.5);
                      stackTop -= h;
                      return <path key={s.id} d={column(x0, stackTop + (h - drawn), barWidth, drawn, isTop)} fill={s.color} />;
                    })}
                    {capLabels &&
                      (stacked
                        ? totals[i]! > 0 && (
                            <text x={x0 + barWidth / 2} y={y(totals[i]!) - 6} textAnchor="middle" className="chart-cap">
                              {formatDollarsShort(totals[i]!)}
                            </text>
                          )
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
            {[...series].reverse().map((s) => (
              <div key={s.id} className="chart-tooltip-row">
                <span className="line-key" style={{ background: s.color }} aria-hidden="true" />
                <strong>{formatCents(s.values[active] ?? 0)}</strong>
                <span>{s.name}</span>
              </div>
            ))}
            {stacked && series.length > 1 && (
              <div className="chart-tooltip-row total">
                <span className="line-key" aria-hidden="true" />
                <strong>{formatCents(series.reduce((sum, s) => sum + (s.values[active] ?? 0), 0))}</strong>
                <span>Total</span>
              </div>
            )}
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

function ChartTable({ periods, series, stacked }: Pick<Props, "periods" | "series" | "stacked">) {
  return (
    <div className="table-scroll">
      <table className="chart-table">
        <thead>
          <tr>
            <th>Period</th>
            {series.map((s) => (
              <th key={s.id} className="num">
                {s.name}
              </th>
            ))}
            {stacked && series.length > 1 && <th className="num">Total</th>}
          </tr>
        </thead>
        <tbody>
          {periods.map((p, i) => (
            <tr key={p.key}>
              <td>{p.longLabel ?? p.label}</td>
              {series.map((s) => (
                <td key={s.id} className="num">
                  {formatCents(s.values[i] ?? 0)}
                </td>
              ))}
              {stacked && series.length > 1 && (
                <td className="num">{formatCents(series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0))}</td>
              )}
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
