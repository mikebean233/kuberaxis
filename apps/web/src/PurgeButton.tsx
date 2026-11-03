import { useEffect, useState } from "react";
import { purgeData } from "./api";

type State = "idle" | "confirming" | "purging";

/** Two-step "delete everything" control for development; the second click must come within a few seconds. */
export function PurgeButton({ onPurged }: { onPurged: () => void }) {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state !== "confirming") return;
    const timer = setTimeout(() => setState("idle"), 5000);
    return () => clearTimeout(timer);
  }, [state]);

  async function purge() {
    setState("purging");
    try {
      await purgeData();
      setError(null);
      onPurged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setState("idle");
    }
  }

  return (
    <div className="purge">
      {error && <span className="purge-error">Purge failed: {error}</span>}
      {state === "confirming" ? (
        // Cancel takes the original button's spot so a double-click can't confirm.
        <>
          <button type="button" className="danger" onClick={() => void purge()}>
            Delete all transactions, imports and accounts
          </button>
          <button type="button" onClick={() => setState("idle")}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" disabled={state === "purging"} onClick={() => setState("confirming")}>
          {state === "purging" ? "Purging…" : "Purge database"}
        </button>
      )}
    </div>
  );
}
