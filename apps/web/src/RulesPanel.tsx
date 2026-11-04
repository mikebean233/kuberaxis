import { useEffect, useState } from "react";
import {
  applyRules,
  createRule,
  deleteRule,
  fetchRules,
  previewRule,
  RequestError,
  updateRule,
  type Category,
  type CategoryRule,
  type CategoryRuleInput,
  type RulePreview,
} from "./api";
import { formatAmount, formatDate } from "./format";

interface Props {
  categories: Category[];
  uncategorizedCount: number;
  /** Called after rules changed transactions' categories, so the table reloads. */
  onApplied: () => void;
}

type Editing = { id: number | null; rule: CategoryRuleInput };

/** The editable fields of a rule; the API rejects the read-only ones. */
const toInput = ({ matchType, pattern, direction, categoryId, priority, enabled }: CategoryRule): CategoryRuleInput => ({
  matchType,
  pattern,
  direction,
  categoryId,
  priority,
  enabled,
});

const DIRECTION_LABELS = { any: "In or out", debit: "Money out", credit: "Money in" } as const;

/** Lists, edits and applies the rules that categorize transactions automatically. */
export function RulesPanel({ categories, uncategorizedCount, onApplied }: Props) {
  const [rules, setRules] = useState<CategoryRule[] | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () =>
    fetchRules().then(setRules, (err: Error) => setStatus({ kind: "error", text: `Couldn't load rules: ${err.message}` }));

  useEffect(() => {
    void reload();
  }, []);

  async function apply(reapply: boolean) {
    setBusy(true);
    try {
      const result = await applyRules(reapply);
      setStatus({
        kind: "success",
        text: `Categorized ${result.categorized} ${result.categorized === 1 ? "transaction" : "transactions"}; ${result.uncategorized} still uncategorized.`,
      });
      await reload();
      if (result.categorized > 0 || reapply) onApplied();
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const startNew = () =>
    setEditing({
      id: null,
      // No default category: saving under whatever sorts first is too easy to do by accident.
      rule: { matchType: "contains", pattern: "", direction: "any", categoryId: 0, priority: 100, enabled: true },
    });

  const query = search.trim().toLowerCase();
  const shown = (rules ?? []).filter(
    (r) => !query || r.pattern.toLowerCase().includes(query) || r.categoryName.toLowerCase().includes(query),
  );

  return (
    <>
      <header className="page-head">
        <h1>Auto-categorize rules</h1>
        <p className="muted">
          {rules ? `${rules.length} rules · ` : ""}
          {uncategorizedCount} uncategorized transactions
        </p>
      </header>
      <section className="panel rules">
        <p className="muted rules-help">
          New transactions are categorized by the first enabled rule that matches their type, description or details, lowest priority number
          first. Categories you pick by hand are never overwritten.
        </p>

        <div className="rules-toolbar">
          <button type="button" className="primary" disabled={busy || uncategorizedCount === 0} onClick={() => void apply(false)}>
            Categorize {uncategorizedCount} uncategorized
          </button>
          <button
            type="button"
            disabled={busy}
            title="Clears categories that rules set earlier, then applies the rules again. Categories set by hand are kept."
            onClick={() => void apply(true)}
          >
            Re-apply all rules
          </button>
          <button type="button" onClick={startNew} disabled={categories.length === 0}>
            Add rule
          </button>
          <input
            type="search"
            placeholder="Find a rule…"
            aria-label="Find a rule"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {status && (
          <p className={`status ${status.kind}`} role={status.kind === "error" ? "alert" : "status"}>
            {status.text}
          </p>
        )}

        {editing && (
          <RuleEditor
            key={editing.id ?? "new"}
            editing={editing}
            categories={categories}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              void reload();
            }}
          />
        )}

        {rules && (
          <div className="table-scroll rules-list">
            <table>
              <thead>
                <tr>
                  <th className="num">Priority</th>
                  <th>Matches text</th>
                  <th>Direction</th>
                  <th>Category</th>
                  <th className="num">Transactions</th>
                  <th>On</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <RuleRow
                    key={r.id}
                    rule={r}
                    onEdit={() => setEditing({ id: r.id, rule: toInput(r) })}
                    onChanged={() => void reload()}
                    onError={(text) => setStatus({ kind: "error", text })}
                  />
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">
                      {rules.length === 0 ? "No rules yet." : "No rules match."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function RuleRow({
  rule,
  onEdit,
  onChanged,
  onError,
}: {
  rule: CategoryRule;
  onEdit: () => void;
  onChanged: () => void;
  onError: (text: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const run = (action: Promise<unknown>) => action.then(onChanged, (err: Error) => onError(err.message));

  return (
    <tr className={rule.enabled ? undefined : "disabled"}>
      <td className="num">{rule.priority}</td>
      <td>
        <code>{rule.pattern}</code>
        {rule.matchType === "regex" && <span className="tag">regex</span>}
      </td>
      <td>{DIRECTION_LABELS[rule.direction]}</td>
      <td>{rule.categoryName}</td>
      <td className="num">{rule.matchCount}</td>
      <td>
        <input
          type="checkbox"
          aria-label={`Rule ${rule.pattern} enabled`}
          checked={rule.enabled}
          onChange={(e) => void run(updateRule(rule.id, { ...toInput(rule), enabled: e.target.checked }))}
        />
      </td>
      <td className="rule-actions">
        <button type="button" className="link" onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className={confirming ? "danger" : "link"}
          onClick={() => (confirming ? void run(deleteRule(rule.id)) : setConfirming(true))}
        >
          {confirming ? "Delete rule" : "Delete"}
        </button>
      </td>
    </tr>
  );
}

function RuleEditor({
  editing,
  categories,
  onCancel,
  onSaved,
}: {
  editing: Editing;
  categories: Category[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [rule, setRule] = useState(editing.rule);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; issues: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<CategoryRuleInput>) => setRule((r) => ({ ...r, ...patch }));

  // Shows what the pattern matches as it's typed.
  useEffect(() => {
    if (!rule.pattern.trim()) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewRule({ matchType: rule.matchType, pattern: rule.pattern, direction: rule.direction }, controller.signal).then(
        (result) => {
          setPreview(result);
          setPreviewError(null);
        },
        (err: Error) => {
          if (controller.signal.aborted) return;
          setPreview(null);
          setPreviewError(err instanceof RequestError && err.issues.length ? `${err.message}: ${err.issues[0]}` : err.message);
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [rule.matchType, rule.pattern, rule.direction]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await (editing.id === null ? createRule(rule) : updateRule(editing.id, rule));
      onSaved();
    } catch (err) {
      setError({ message: (err as Error).message, issues: err instanceof RequestError ? err.issues : [] });
      setSaving(false);
    }
  }

  return (
    <form
      className="rule-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="filters">
        <label>
          Match
          <select value={rule.matchType} onChange={(e) => set({ matchType: e.target.value as CategoryRuleInput["matchType"] })}>
            <option value="contains">Contains text</option>
            <option value="regex">Regular expression</option>
          </select>
        </label>
        <label className="search">
          Pattern
          <input
            autoFocus
            value={rule.pattern}
            placeholder={rule.matchType === "regex" ? "e.g. CARL'?S JR" : "e.g. DUTCH BROS"}
            onChange={(e) => set({ pattern: e.target.value })}
          />
        </label>
        <label>
          Direction
          <select value={rule.direction} onChange={(e) => set({ direction: e.target.value as CategoryRuleInput["direction"] })}>
            {Object.entries(DIRECTION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Category
          <select
            value={rule.categoryId}
            className={rule.categoryId ? undefined : "uncategorized"}
            onChange={(e) => set({ categoryId: Number(e.target.value) })}
          >
            <option value={0} disabled>
              Choose a category…
            </option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="amount">
          Priority
          <input
            type="number"
            step="1"
            value={rule.priority}
            onChange={(e) => set({ priority: Math.trunc(Number(e.target.value)) || 0 })}
          />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={rule.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Enabled
        </label>
      </div>

      <div className="rule-preview">
        {previewError && <p className="status error">{previewError}</p>}
        {preview && (
          <>
            <p className="muted">
              Matches {preview.total} {preview.total === 1 ? "transaction" : "transactions"}, {preview.uncategorized} of them uncategorized
              {preview.total > preview.examples.length && `; the latest ${preview.examples.length}`}:
            </p>
            <ul>
              {preview.examples.map((t) => (
                <li key={t.id}>
                  <span className="muted">{formatDate(t.postedDate)}</span> {[t.description, ...t.details].join(" · ")}{" "}
                  <span className={t.amount < 0 ? "debit" : "credit"}>{formatAmount(t.amount)}</span>
                  {t.categoryName && <span className="tag">{t.categoryName}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {error && (
        <div className="status error" role="alert">
          {error.message}
          {error.issues.length > 0 && <div>{error.issues.join("; ")}</div>}
        </div>
      )}
      <div className="itemize-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving || !rule.pattern.trim() || !rule.categoryId}>
          {saving ? "Saving…" : editing.id === null ? "Add rule" : "Save rule"}
        </button>
      </div>
    </form>
  );
}
