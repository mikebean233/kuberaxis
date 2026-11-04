import { useEffect, useId, useRef, useState } from "react";
import {
  createCategory,
  fetchTransactionItems,
  RequestError,
  saveTransactionItems,
  type Category,
  type TransactionItem,
  type TransactionRow,
} from "./api";
import { formatCents, formatDate, parseCents } from "./format";

/** An item being edited. Amounts are typed as positive for a purchase, whatever the transaction's sign. */
interface Draft {
  key: number;
  description: string;
  category: string;
  amount: string;
}

let nextKey = 0;
const draft = (description: string, category: string, cents: number): Draft => ({
  key: nextKey++,
  description,
  category,
  amount: cents === 0 ? "" : (cents / 100).toFixed(2),
});

interface Props {
  transaction: TransactionRow;
  categories: Category[];
  onCategoryCreated: (category: Category) => void;
  onSaved: (items: TransactionItem[]) => void;
  onClose: () => void;
}

/** Modal editor that breaks one transaction into items, each with its own category. */
export function ItemizeDialog({ transaction, categories, onCategoryCreated, onSaved, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listId = useId();
  // Purchases are stored negative; the editor shows them positive.
  const direction = transaction.amount < 0 ? -1 : 1;
  const totalCents = Math.round(transaction.amount * 100) * direction;

  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; issues: string[] } | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchTransactionItems(transaction.id).then(
      (items) => {
        if (cancelled) return;
        setSavedCount(items.length);
        setDrafts(
          items.length
            ? items.map((i) => draft(i.description, i.categoryName ?? "", Math.round(i.amount * 100) * direction))
            : [draft("", "", totalCents)],
        );
      },
      (err: Error) => !cancelled && setError({ message: err.message, issues: [] }),
    );
    return () => {
      cancelled = true;
    };
  }, [transaction.id, direction, totalCents]);

  const rows = drafts ?? [];
  const parsed = rows.map((d) => parseCents(d.amount));
  const allValid = parsed.every((c) => c !== null) && rows.every((d) => d.description.trim() || d.category.trim());
  const itemizedCents = parsed.reduce<number>((sum, c) => sum + (c ?? 0), 0);
  const remainingCents = totalCents - itemizedCents;
  const canSave = drafts !== null && !saving && (rows.length === 0 || (allValid && remainingCents === 0));

  const update = (key: number, patch: Partial<Draft>) => setDrafts((ds) => ds && ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));
      const items = [];
      for (const [i, d] of rows.entries()) {
        const name = d.category.trim();
        let category = name ? byName.get(name.toLowerCase()) : undefined;
        if (name && !category) {
          category = await createCategory(name);
          byName.set(name.toLowerCase(), category);
          onCategoryCreated(category);
        }
        items.push({ description: d.description.trim(), amount: (parsed[i]! * direction) / 100, categoryId: category?.id ?? null });
      }
      onSaved(await saveTransactionItems(transaction.id, items));
    } catch (err) {
      setError({ message: (err as Error).message, issues: err instanceof RequestError ? err.issues : [] });
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="itemize"
      aria-labelledby={`${listId}-title`}
      onClose={onClose}
      onClick={(e) => e.target === dialogRef.current && dialogRef.current.close()}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) void save();
        }}
      >
        <h2 id={`${listId}-title`}>Itemize transaction</h2>
        <p className="itemize-subject">
          {formatDate(transaction.postedDate)} · {transaction.description} ·{" "}
          <span className={transaction.amount < 0 ? "debit" : "credit"}>{formatCents(Math.round(transaction.amount * 100))}</span>
        </p>

        {drafts === null && !error && <p className="muted">Loading…</p>}
        {drafts !== null && (
          <table className="itemize-table">
            <thead>
              <tr>
                <th>Description</th>
                <th>Category</th>
                <th className="num">Amount</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {rows.map((d, i) => (
                <tr key={d.key}>
                  <td>
                    <input
                      aria-label={`Item ${i + 1} description`}
                      value={d.description}
                      onChange={(e) => update(d.key, { description: e.target.value })}
                      autoFocus={i === 0}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Item ${i + 1} category`}
                      list={`${listId}-categories`}
                      placeholder="Uncategorized"
                      value={d.category}
                      onChange={(e) => update(d.key, { category: e.target.value })}
                    />
                  </td>
                  <td className="num">
                    <input
                      aria-label={`Item ${i + 1} amount`}
                      inputMode="decimal"
                      className={parsed[i] === null ? "invalid" : undefined}
                      value={d.amount}
                      onChange={(e) => update(d.key, { amount: e.target.value })}
                    />
                  </td>
                  <td>
                    <button type="button" className="link" onClick={() => setDrafts(rows.filter((r) => r.key !== d.key))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No items. Saving removes the itemization.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        <datalist id={`${listId}-categories`}>
          {categories.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>

        {drafts !== null && (
          <div className="itemize-tools">
            <button type="button" onClick={() => setDrafts([...rows, draft("", "", 0)])}>
              Add item
            </button>
            <button
              type="button"
              disabled={remainingCents === 0 || !parsed.every((c) => c !== null)}
              onClick={() => setDrafts([...rows, draft("", "", remainingCents)])}
            >
              Add remaining
            </button>
            {savedCount > 0 && rows.length > 0 && (
              <button type="button" onClick={() => setDrafts([])}>
                Clear all
              </button>
            )}
            <span className={`itemize-remaining${!allValid ? " hint" : remainingCents === 0 ? "" : " off"}`}>
              {rows.length > 0 &&
                (!allValid
                  ? "Each item needs an amount, and a description or category"
                  : remainingCents === 0
                    ? "Fully itemized"
                    : `${formatCents(Math.abs(remainingCents))} ${remainingCents > 0 ? "left to itemize" : "over the total"}`)}
            </span>
          </div>
        )}

        {error && (
          <div className="status error" role="alert">
            {error.message}
            {error.issues.length > 0 && (
              <ul>
                {error.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="itemize-actions">
          <button type="button" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!canSave}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
