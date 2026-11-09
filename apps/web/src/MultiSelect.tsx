import { useEffect, useId, useRef, useState } from "react";

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Shown as a swatch, e.g. the option's chart color. */
  color?: string;
}

interface Props {
  label: string;
  /** What the button says when nothing is selected, e.g. "All categories". */
  allLabel: string;
  groups: { label: string; options: MultiSelectOption[] }[];
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
}

/**
 * A dropdown of checkboxes in groups: a checkbox toggles its option, its name selects only that option.
 * Nothing selected means everything.
 */
export function MultiSelect({ label, allLabel, groups, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const options = groups.flatMap((g) => g.options);
  const chosen = options.filter((o) => selected.has(o.value));
  const summary = chosen.length === 0 ? allLabel : chosen.length === 1 ? chosen[0]!.label : `${chosen.length} selected`;

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (!next.delete(value)) next.add(value);
    onChange(next);
  };

  return (
    <div className="multiselect" ref={rootRef}>
      <span id={`${id}-label`}>{label}</span>
      <button
        ref={buttonRef}
        type="button"
        className="multiselect-button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        aria-labelledby={`${id}-label ${id}-summary`}
        onClick={() => setOpen((v) => !v)}
      >
        <span id={`${id}-summary`}>{summary}</span>
        <span className="multiselect-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div id={`${id}-panel`} className="multiselect-panel">
          <button type="button" className="link" disabled={chosen.length === 0} onClick={() => onChange(new Set())}>
            Clear ({allLabel.toLowerCase()})
          </button>
          {groups
            .filter((g) => g.options.length > 0)
            .map((g) => (
              <fieldset key={g.label}>
                <legend>{g.label}</legend>
                {/* The checkbox adds or removes one option; the name picks it alone. */}
                {g.options.map((o) => (
                  <div key={o.value} className="multiselect-option">
                    <input
                      type="checkbox"
                      aria-label={`Include ${o.label}`}
                      checked={selected.has(o.value)}
                      onChange={() => toggle(o.value)}
                    />
                    <button type="button" title={`Show only ${o.label}`} onClick={() => onChange(new Set([o.value]))}>
                      {o.color && <span className="swatch" style={{ background: o.color }} aria-hidden="true" />}
                      {o.label}
                    </button>
                  </div>
                ))}
              </fieldset>
            ))}
        </div>
      )}
    </div>
  );
}
