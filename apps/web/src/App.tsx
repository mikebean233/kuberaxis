import { useCallback, useEffect, useState } from "react";
import { fetchTransactions, type TransactionRow } from "./api";
import { ImportPanel } from "./ImportPanel";
import { PurgeButton } from "./PurgeButton";
import { TransactionsTable } from "./TransactionsTable";

export function App() {
  const [transactions, setTransactions] = useState<TransactionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on purge to remount the import panel and clear its results.
  const [generation, setGeneration] = useState(0);

  const load = useCallback(async () => {
    try {
      setTransactions(await fetchTransactions());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main>
      <header>
        <h1>Kuberaxis</h1>
        <PurgeButton
          onPurged={() => {
            setGeneration((g) => g + 1);
            void load();
          }}
        />
      </header>
      <ImportPanel key={generation} onImported={load} />
      {error && (
        <p className="status error" role="alert">
          Couldn't load transactions: {error}
        </p>
      )}
      {transactions && <TransactionsTable data={transactions} />}
    </main>
  );
}
