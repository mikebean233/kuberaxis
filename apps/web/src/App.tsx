import { useCallback, useEffect, useState } from "react";
import {
  fetchAccounts,
  fetchCategories,
  fetchTransactions,
  setTransactionCategory,
  type Account,
  type Category,
  type TransactionItem,
  type TransactionRow,
} from "./api";
import { AccountsPanel } from "./AccountsPanel";
import { CategoriesPanel } from "./CategoriesPanel";
import { HomePage } from "./HomePage";
import { ImportPanel } from "./ImportPanel";
import { ItemizeDialog } from "./ItemizeDialog";
import { PurgeButton } from "./PurgeButton";
import { RulesPanel } from "./RulesPanel";
import { CashFlowPage } from "./CashFlowPage";
import { ThemePicker } from "./ThemePicker";
import { TransactionsTable } from "./TransactionsTable";

const TABS = [
  { id: "home", label: "Home" },
  { id: "cashflow", label: "Cash flow" },
  { id: "transactions", label: "Transactions" },
  { id: "accounts", label: "Accounts" },
  { id: "categories", label: "Categories" },
  { id: "rules", label: "Rules" },
  { id: "import", label: "Import" },
] as const;

type Tab = (typeof TABS)[number]["id"];

const tabFromHash = (): Tab => {
  const raw = window.location.hash.replace(/^#\/?/, "");
  // The cash flow page used to be "spending"; keep old links and bookmarks working.
  const id = raw === "spending" ? "cashflow" : raw;
  return TABS.some((t) => t.id === id) ? (id as Tab) : "home";
};

/** The current tab, kept in the URL hash so reloads and back/forward keep your place. */
function useTab(): [Tab, (tab: Tab) => void] {
  const [tab, setTab] = useState(tabFromHash);
  useEffect(() => {
    const onChange = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return [tab, (next) => (window.location.hash = `/${next}`)];
}

export function App() {
  const [tab, setTab] = useTab();
  const [transactions, setTransactions] = useState<TransactionRow[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [itemizing, setItemizing] = useState<TransactionRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on purge to remount the import panel and clear its results.
  const [generation, setGeneration] = useState(0);

  const load = useCallback(async () => {
    try {
      const [loaded, loadedCategories, loadedAccounts] = await Promise.all([
        fetchTransactions(),
        fetchCategories(),
        fetchAccounts(),
      ]);
      setTransactions(loaded);
      setCategories(loadedCategories);
      setAccounts(loadedAccounts);
      setError(null);
    } catch (err) {
      setError(`Couldn't load transactions: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.title = `${TABS.find((t) => t.id === tab)!.label} · Kuberaxis`;
  }, [tab]);

  const patch = (id: string, change: Partial<TransactionRow>) =>
    setTransactions((ts) => ts && ts.map((t) => (t.id === id ? { ...t, ...change } : t)));

  async function setCategory(transaction: TransactionRow, categoryId: number | null) {
    try {
      const saved = await setTransactionCategory(transaction.id, categoryId);
      patch(transaction.id, {
        ...saved,
        categoryRuleId: null,
        ...(transaction.itemCount === 0 && { allocations: [{ categoryId: saved.categoryId, amount: transaction.amount }] }),
      });
      setError(null);
    } catch (err) {
      setError(`Couldn't change the category: ${(err as Error).message}`);
    }
  }

  const uncategorizedCount = (transactions ?? []).filter((t) => t.itemCount === 0 && t.categoryId === null).length;

  function itemsSaved(transaction: TransactionRow, items: TransactionItem[]) {
    const names = [...new Set(items.flatMap((i) => (i.categoryName ? [i.categoryName] : [])))].sort();
    const allocations = items.length
      ? items.map((i) => ({ categoryId: i.categoryId, amount: i.amount }))
      : [{ categoryId: transaction.categoryId, amount: transaction.amount }];
    patch(transaction.id, { itemCount: items.length, categories: names, allocations });
    setItemizing(null);
  }

  function categoryChanged(category: Category) {
    const previous = categories.find((c) => c.id === category.id);
    setCategories((cs) => [...cs.filter((c) => c.id !== category.id), category].sort((a, b) => a.name.localeCompare(b.name)));
    // Transactions carry category names, so a rename needs fresh rows.
    if (previous && previous.name !== category.name) void load();
  }

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Sections">
        <div className="brand">Kuberaxis</div>
        <ul>
          {TABS.map((t) => (
            <li key={t.id}>
              <a href={`#/${t.id}`} aria-current={tab === t.id ? "page" : undefined}>
                {t.label}
                {t.id === "transactions" && uncategorizedCount > 0 && (
                  <span className="nav-count" title={`${uncategorizedCount} uncategorized`}>
                    {uncategorizedCount}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
        <ThemePicker />
        <div className="sidebar-foot">
          <PurgeButton
            onPurged={() => {
              setGeneration((g) => g + 1);
              void load();
            }}
          />
        </div>
      </nav>

      <main>
        {error && (
          <p className="status error" role="alert">
            {error}
          </p>
        )}
        {tab === "import" && (
          <>
            <header className="page-head">
              <h1>Import</h1>
              <p className="muted">New transactions are categorized by your rules as they come in.</p>
            </header>
            <ImportPanel key={generation} onImported={load} accounts={accounts} onAccountAdded={load} />
          </>
        )}
        {tab === "accounts" && <AccountsPanel accounts={accounts} onChanged={load} />}
        {tab === "categories" && <CategoriesPanel categories={categories} onChanged={categoryChanged} onDeleted={load} />}
        {tab === "rules" && <RulesPanel categories={categories} uncategorizedCount={uncategorizedCount} onApplied={load} />}
        {transactions === null ? (
          !error && tab !== "import" && tab !== "accounts" && tab !== "categories" && tab !== "rules" && <p className="muted">Loading…</p>
        ) : (
          <>
            {tab === "home" && <HomePage transactions={transactions} categories={categories} onNavigate={setTab} />}
            {tab === "cashflow" && <CashFlowPage transactions={transactions} categories={categories} accounts={accounts} />}
            {tab === "transactions" && (
              <>
                <header className="page-head">
                  <h1>Transactions</h1>
                </header>
                <TransactionsTable data={transactions} categories={categories} onItemize={setItemizing} onSetCategory={setCategory} />
              </>
            )}
          </>
        )}
      </main>

      {itemizing && (
        <ItemizeDialog
          transaction={itemizing}
          categories={categories}
          onCategoryCreated={(c) => setCategories((cs) => [...cs, c].sort((a, b) => a.name.localeCompare(b.name)))}
          onSaved={(items) => itemsSaved(itemizing, items)}
          onClose={() => setItemizing(null)}
        />
      )}
    </div>
  );
}
