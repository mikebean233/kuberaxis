import { useRef, useState } from "react";
import { accountLabel, ACCOUNT_KIND_LABELS, KindSelect } from "./AccountsPanel";
import { createAccount, RequestError, uploadStatement, type Account, type AccountKind, type ImportResult } from "./api";

type FileStatus =
  | { kind: "pending" }
  | { kind: "uploading" }
  | { kind: "done"; result: ImportResult }
  | { kind: "error"; message: string; issues: string[] };

interface QueuedFile {
  id: number;
  name: string;
  status: FileStatus;
}

let nextId = 0;

const isCsv = (file: File) => /\.csv$/i.test(file.name) || file.type === "text/csv";

interface Props {
  onImported: () => void;
  accounts: Account[];
  onAccountAdded: () => void;
}

export function ImportPanel({ onImported, accounts, onAccountAdded }: Props) {
  // null until the user picks; then the only credit card, if there's exactly one, is the default.
  const [picked, setPicked] = useState<number | null>(null);
  const cards = accounts.filter((a) => a.kind === "credit_card");
  const csvAccountId = picked ?? (cards.length === 1 ? cards[0]!.id : null);
  const csvAccount = accounts.find((a) => a.id === csvAccountId);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const setStatus = (id: number, status: FileStatus) =>
    setQueue((q) => q.map((item) => (item.id === id ? { ...item, status } : item)));

  /**
   * Uploads one file at a time so each import commits before the next starts; transactions
   * shared between the files are then skipped by the server's de-duplication.
   */
  async function upload(files: File[]) {
    if (files.length === 0) return;
    const items = files.map((file) => ({ id: nextId++, file }));
    setQueue(items.map(({ id, file }) => ({ id, name: file.name, status: { kind: "pending" } })));
    setBusy(true);

    let anyChanged = false;
    for (const { id, file } of items) {
      if (isCsv(file) && !csvAccount) {
        setStatus(id, { kind: "error", message: "Choose the account for CSV files below, then add this file again.", issues: [] });
        continue;
      }
      setStatus(id, { kind: "uploading" });
      try {
        const result = await uploadStatement(file, isCsv(file) ? csvAccount!.id : undefined);
        setStatus(id, { kind: "done", result });
        anyChanged ||= result.inserted > 0 || result.corrected > 0;
      } catch (err) {
        const issues = err instanceof RequestError ? err.issues : [];
        setStatus(id, { kind: "error", message: (err as Error).message, issues });
      }
    }

    setBusy(false);
    if (anyChanged) onImported();
  }

  return (
    <section className="panel">
      <div
        className={`dropzone${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy) void upload([...e.dataTransfer.files]);
        }}
      >
        <p>
          Drop U.S. Bank statement PDFs or transaction CSVs here, or{" "}
          <button type="button" className="link" disabled={busy} onClick={() => inputRef.current?.click()}>
            choose files
          </button>
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf,text/csv,.csv"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            void upload(files);
          }}
        />
      </div>
      <CsvAccountPicker
        accounts={accounts}
        value={csvAccount?.id ?? null}
        disabled={busy}
        onChange={setPicked}
        onCreated={(account) => {
          setPicked(account.id);
          onAccountAdded();
        }}
      />
      {queue.length > 0 && <ImportSummary queue={queue} />}
    </section>
  );
}

function ImportSummary({ queue }: { queue: QueuedFile[] }) {
  const results = queue.flatMap((item) => (item.status.kind === "done" ? [item.status.result] : []));
  const finished = queue.every((item) => item.status.kind === "done" || item.status.kind === "error");
  const inserted = results.reduce((sum, r) => sum + r.inserted, 0);
  const skipped = results.reduce((sum, r) => sum + r.skipped, 0);
  const failed = queue.filter((item) => item.status.kind === "error").length;

  return (
    <div className="import-results">
      {queue.length > 1 && (
        <p className="status">
          {finished ? "Imported" : `Importing ${results.length + failed + 1} of ${queue.length}…`} {inserted} new,{" "}
          {skipped} already imported
          {failed > 0 && `, ${failed} ${failed === 1 ? "file" : "files"} failed`}.
        </p>
      )}
      <ul className="file-list">
        {queue.map((item) => (
          <FileRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

function FileRow({ item: { name, status } }: { item: QueuedFile }) {
  switch (status.kind) {
    case "pending":
      return <li className="status">{name}: waiting…</li>;
    case "uploading":
      return <li className="status">{name}: importing…</li>;
    case "error":
      return (
        <li className="status error" role="alert">
          <strong>{name}:</strong> {status.message}
          {status.issues.length > 0 && <IssueList issues={status.issues} />}
        </li>
      );
    case "done": {
      const { result } = status;
      const issues = result.accounts.flatMap((a) => a.validationIssues.map((i) => `${a.accountName}: ${i}`));
      return (
        <li className={`status ${issues.length ? "warning" : "success"}`}>
          <strong>{name}</strong> ({result.period.start} to {result.period.end}): {result.inserted} new, {result.skipped}{" "}
          already imported{result.corrected > 0 && ` (${result.corrected} corrected)`}
          {result.categorized > 0 && `, ${result.categorized} auto-categorized`}.
          {result.accounts.some((a) => a.accountCreated) && (
            <p>
              New {result.accounts.filter((a) => a.accountCreated).length === 1 ? "account" : "accounts"}:{" "}
              {result.accounts
                .filter((a) => a.accountCreated)
                .map((a) => a.accountName)
                .join(", ")}
              . Rename them on the Accounts page.
            </p>
          )}
          {issues.length > 0 && (
            <>
              <p>The statement didn't fully reconcile, so some transactions may be missing or wrong:</p>
              <IssueList issues={issues} />
            </>
          )}
        </li>
      );
    }
  }
}

const IssueList = ({ issues }: { issues: string[] }) => (
  <ul>
    {issues.map((issue) => (
      <li key={issue}>{issue}</li>
    ))}
  </ul>
);

const NEW = "new";

/** Which account CSV files go into, with a way to add one on the spot. */
function CsvAccountPicker({
  accounts,
  value,
  disabled,
  onChange,
  onCreated,
}: {
  accounts: Account[];
  value: number | null;
  disabled: boolean;
  onChange: (id: number) => void;
  onCreated: (account: Account) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AccountKind>("credit_card");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="csv-account">
      <label>
        CSV files go into{" "}
        <select
          value={adding ? NEW : (value ?? "")}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value === NEW) return setAdding(true);
            setAdding(false);
            onChange(Number(e.target.value));
          }}
        >
          {value === null && !adding && <option value="">Choose an account…</option>}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {accountLabel(a)} ({ACCOUNT_KIND_LABELS[a.kind]})
            </option>
          ))}
          <option value={NEW}>New account…</option>
        </select>
      </label>
      {adding && (
        <form
          className="add-category"
          onSubmit={(e) => {
            e.preventDefault();
            createAccount({ name: name.trim(), kind, bank: "U.S. Bank", accountNumber: "" }).then(
              (account) => {
                setAdding(false);
                setName("");
                setError(null);
                onCreated(account);
              },
              (err: Error) => setError(err.message),
            );
          }}
        >
          <input aria-label="New account name" placeholder="e.g. Visa" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          <KindSelect value={kind} onChange={setKind} />
          <button type="submit" disabled={!name.trim()}>
            Add
          </button>
          <button type="button" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </form>
      )}
      <p className="muted csv-account-help">
        A CSV download (Date, Transaction, Name, Memo, Amount) doesn't say which account it's from. Statement PDFs find
        or create their own account.
      </p>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
