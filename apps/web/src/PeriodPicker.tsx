import {
  type DateSpan,
  endOfMonth,
  monthOf,
  monthRangeLabel,
  monthsEnding,
  type PeriodSize,
  spanOf,
  spansBetween,
} from "./analytics";
import { formatDate } from "./format";

const ROLLING = [
  { id: "3", label: "Last 3 months", months: 3, size: "quarter" },
  { id: "6", label: "Last 6 months", months: 6, size: "half" },
  { id: "12", label: "Last 12 months", months: 12, size: "year" },
  { id: "all", label: "All time", months: null, size: null },
] as const;

const CALENDAR: { id: PeriodSize; label: string }[] = [
  { id: "month", label: "Month" },
  { id: "quarter", label: "Quarter" },
  { id: "half", label: "Half year" },
  { id: "year", label: "Year" },
];

export type PeriodChoice = (typeof ROLLING)[number]["id"] | PeriodSize | "custom";

export interface PeriodState {
  choice: PeriodChoice;
  /** The chosen calendar period's key; null (or a key outside the data) means the latest. */
  key: string | null;
  /** The custom dates; null until first chosen, which starts them at the latest month. */
  custom: DateSpan | null;
}

export const DEFAULT_PERIOD: PeriodState = { choice: "6", key: null, custom: null };

const isCalendar = (choice: PeriodChoice): choice is PeriodSize => CALENDAR.some((c) => c.id === choice);

/**
 * The dates a period choice covers, given the data's first and last spend dates, and the calendar size it matches
 * (a rolling 3 months is a quarter long); null for all time and custom dates.
 */
export function resolvePeriod(state: PeriodState, first: string, last: string) {
  const { choice } = state;
  if (choice === "custom") {
    const span = state.custom ?? spanOf("month", last);
    return { span, size: null, label: `${formatDate(span.start)} – ${formatDate(span.end)}`, spans: [], index: 0 };
  }
  if (isCalendar(choice)) {
    const spans = spansBetween(choice, first, last);
    const index = Math.max(
      spans.findIndex((s) => s.key === state.key),
      0,
    );
    return { span: spans[index]!, size: choice, label: spans[index]!.label, spans, index };
  }
  const rolling = ROLLING.find((r) => r.id === choice)!;
  const lastMonth = monthOf(last);
  const firstMonth = rolling.months === null ? monthOf(first) : monthsEnding(lastMonth, rolling.months)[0]!;
  const span = { key: choice, label: rolling.label, start: `${firstMonth}-01`, end: endOfMonth(lastMonth) };
  return { span, size: rolling.size, label: monthRangeLabel(firstMonth, lastMonth), spans: [], index: 0 };
}

interface Props {
  state: PeriodState;
  onChange: (state: PeriodState) => void;
  first: string;
  last: string;
}

/** Rolling ranges, calendar periods with a stepper, or custom dates. */
export function PeriodPicker({ state, onChange, first, last }: Props) {
  const { span, spans, index } = resolvePeriod(state, first, last);

  const changeChoice = (choice: PeriodChoice) => {
    // Keep roughly the same place in time: the new period containing the end of the current one.
    const anchor = span.end > last ? last : span.end < first ? first : span.end;
    onChange({
      choice,
      key: isCalendar(choice) ? spanOf(choice, anchor).key : state.key,
      custom: choice === "custom" ? { ...span, start: span.start < first ? first : span.start, end: anchor } : state.custom,
    });
  };

  return (
    <>
      <label>
        Period
        <select value={state.choice} onChange={(e) => changeChoice(e.target.value as PeriodChoice)}>
          <optgroup label="Rolling">
            {ROLLING.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Calendar">
            {CALENDAR.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </optgroup>
          <option value="custom">Custom dates</option>
        </select>
      </label>
      {state.choice === "custom" && (
        <>
          <label>
            From
            <input
              type="date"
              value={span.start}
              max={span.end}
              onChange={(e) => e.target.value && onChange({ ...state, custom: { ...span, start: e.target.value } })}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={span.end}
              min={span.start}
              onChange={(e) => e.target.value && onChange({ ...state, custom: { ...span, end: e.target.value } })}
            />
          </label>
        </>
      )}
      {isCalendar(state.choice) && (
        <div className="period-stepper">
          <button
            type="button"
            aria-label="Previous period"
            disabled={index >= spans.length - 1}
            onClick={() => onChange({ ...state, key: spans[index + 1]!.key })}
          >
            ‹
          </button>
          <label>
            <span className="visually-hidden">Which {state.choice}</span>
            <select value={span.key} onChange={(e) => onChange({ ...state, key: e.target.value })}>
              {spans.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            aria-label="Next period"
            disabled={index === 0}
            onClick={() => onChange({ ...state, key: spans[index - 1]!.key })}
          >
            ›
          </button>
        </div>
      )}
    </>
  );
}
