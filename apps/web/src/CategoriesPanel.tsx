import { Fragment, useCallback, useEffect, useState } from "react";
import {
  createCategory,
  deleteCategory,
  fetchCategoryUsage,
  updateCategory,
  type Category,
  type CategoryKind,
  type CategoryUsage,
} from "./api";

export const KIND_LABELS: Record<CategoryKind, string> = {
  expense: "Spending",
  income: "Income",
  transfer: "Transfer",
};

const KIND_HELP =
  "Spending counts toward what you spend (refunds in it reduce it), Income toward what you earn, and Transfer is money " +
  "moving between your own accounts, such as credit card payments and investments, which counts as neither.";

interface Props {
  categories: Category[];
  onChanged: (category: Category) => void;
  /** Called after a delete, which can change transactions and rules too. */
  onDeleted: () => void;
}

/** Lists categories with how each counts, and lets you add, rename and delete them. */
export function CategoriesPanel({ categories, onChanged, onDeleted }: Props) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<CategoryKind | "all">("all");
  const [usage, setUsage] = useState<Record<number, CategoryUsage>>({});
  const [deleting, setDeleting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadUsage = useCallback(
    () => fetchCategoryUsage().then(setUsage, (err: Error) => setError(`Couldn't load usage: ${err.message}`)),
    [],
  );
  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  async function save(category: Category, change: Partial<Pick<Category, "name" | "kind">>) {
    const next = { name: change.name?.trim() || category.name, kind: change.kind ?? category.kind };
    if (next.name === category.name && next.kind === category.kind) return;
    try {
      onChanged(await updateCategory(category.id, next));
      setError(null);
    } catch (err) {
      setError(`Couldn't update "${category.name}": ${(err as Error).message}`);
    }
  }

  async function remove(category: Category, moveTo: number | null) {
    try {
      await deleteCategory(category.id, moveTo);
      setDeleting(null);
      setError(null);
      onDeleted();
      void loadUsage();
    } catch (err) {
      setError(`Couldn't delete "${category.name}": ${(err as Error).message}`);
    }
  }

  const counts = categories.reduce<Record<CategoryKind, number>>((acc, c) => ({ ...acc, [c.kind]: acc[c.kind] + 1 }), {
    expense: 0,
    income: 0,
    transfer: 0,
  });
  const query = search.trim().toLowerCase();
  const shown = categories.filter(
    (c) => (kindFilter === "all" || c.kind === kindFilter) && (!query || c.name.toLowerCase().includes(query)),
  );

  return (
    <>
      <header className="page-head">
        <h1>Categories</h1>
        <p className="muted">
          {counts.expense} spending · {counts.income} income · {counts.transfer} transfer
        </p>
      </header>

      <section className="panel categories">
        <p className="muted rules-help">{KIND_HELP}</p>

        <div className="rules-toolbar">
          <input
            type="search"
            aria-label="Search categories"
            placeholder="Search categories…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            aria-label="Show categories that count as"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}
          >
            <option value="all">All kinds</option>
            {Object.entries(KIND_LABELS).map(([k, text]) => (
              <option key={k} value={k}>
                {text}
              </option>
            ))}
          </select>
          <AddCategory onAdded={onChanged} onError={setError} />
        </div>
        {error && (
          <p className="status error" role="alert">
            {error}
          </p>
        )}

        <div className="table-scroll">
          <table className="category-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Counts as</th>
                <th>Used by</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <Fragment key={c.id}>
                  <tr className={deleting === c.id ? "selected" : undefined}>
                    <td>
                      <input
                        aria-label={`Name of ${c.name}`}
                        defaultValue={c.name}
                        key={c.name}
                        onBlur={(e) => void save(c, { name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") {
                            e.currentTarget.value = c.name;
                            e.currentTarget.blur();
                          }
                        }}
                      />
                    </td>
                    <td>
                      <KindSelect label={`How ${c.name} counts`} value={c.kind} onChange={(k) => void save(c, { kind: k })} />
                    </td>
                    <td className="muted">{describeUsage(usage[c.id])}</td>
                    <td className="row-actions">
                      <button type="button" className="link" onClick={() => setDeleting(deleting === c.id ? null : c.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                  {deleting === c.id && (
                    <tr className="selected">
                      <td colSpan={4}>
                        <DeleteConfirm
                          category={c}
                          usage={usage[c.id]}
                          others={categories.filter((o) => o.id !== c.id)}
                          onCancel={() => setDeleting(null)}
                          onConfirm={(moveTo) => void remove(c, moveTo)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    {categories.length === 0 ? "No categories yet." : "No categories match."}
                    {query && !categories.some((c) => c.name.toLowerCase() === query) && (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="link"
                          onClick={() =>
                            createCategory(search.trim()).then(
                              (category) => {
                                onChanged(category);
                                setSearch("");
                              },
                              (err: Error) => setError(err.message),
                            )
                          }
                        >
                          Add “{search.trim()}”
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function describeUsage(usage: CategoryUsage | undefined): string {
  if (!usage) return "Unused";
  const parts = [
    usage.transactions && `${usage.transactions} ${usage.transactions === 1 ? "transaction" : "transactions"}`,
    usage.items && `${usage.items} split ${usage.items === 1 ? "item" : "items"}`,
    usage.rules && `${usage.rules} ${usage.rules === 1 ? "rule" : "rules"}`,
  ].filter(Boolean);
  return parts.join(" · ");
}

function AddCategory({ onAdded, onError }: { onAdded: (c: Category) => void; onError: (e: string) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CategoryKind>("expense");

  return (
    <form
      className="add-category"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        createCategory(name.trim(), kind).then(
          (category) => {
            setName("");
            onAdded(category);
          },
          (err: Error) => onError(err.message),
        );
      }}
    >
      <input aria-label="New category name" placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} />
      <KindSelect value={kind} onChange={setKind} />
      <button type="submit" disabled={!name.trim()}>
        Add category
      </button>
    </form>
  );
}

function DeleteConfirm({
  category,
  usage,
  others,
  onCancel,
  onConfirm,
}: {
  category: Category;
  usage: CategoryUsage | undefined;
  others: Category[];
  onCancel: () => void;
  onConfirm: (moveTo: number | null) => void;
}) {
  const [moveTo, setMoveTo] = useState<number | null>(null);
  return (
    <div className="delete-confirm">
      <p>
        Delete <strong>{category.name}</strong>?{" "}
        {usage ? <>It's used by {describeUsage(usage)}.</> : <span className="muted">Nothing uses it.</span>}
      </p>
      {usage && (
        <label>
          {"Move them to "}
          <select value={moveTo ?? ""} onChange={(e) => setMoveTo(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Nothing (leave uncategorized, delete its rules)</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="delete-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={() => onConfirm(moveTo)}>
          Delete category
        </button>
      </div>
    </div>
  );
}

function KindSelect({
  value,
  onChange,
  label = "Counts as",
}: {
  value: CategoryKind;
  onChange: (kind: CategoryKind) => void;
  label?: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as CategoryKind)}>
      {Object.entries(KIND_LABELS).map(([k, text]) => (
        <option key={k} value={k}>
          {text}
        </option>
      ))}
    </select>
  );
}
