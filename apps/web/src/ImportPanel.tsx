import { useRef, useState } from "react";
import { RequestError, uploadStatement, type ImportResult } from "./api";

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

export function ImportPanel({ onImported }: { onImported: () => void }) {
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
      setStatus(id, { kind: "uploading" });
      try {
        const result = await uploadStatement(file);
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
          Drop U.S. Bank statement PDFs here, or{" "}
          <button type="button" className="link" disabled={busy} onClick={() => inputRef.current?.click()}>
            choose files
          </button>
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            void upload(files);
          }}
        />
      </div>
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
          already imported{result.corrected > 0 && ` (${result.corrected} corrected)`}.
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
