import { Fragment, useState } from "react";
import { createAccount, deleteAccount, updateAccount, type Account, type AccountInput, type AccountKind } from "./api";

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
  other: "Other",
};

/** The name, with the end of the account number when there is one, so similar names can be told apart. */
export function accountLabel(account: Pick<Account, "name" | "accountNumber">): string {
  const digits = account.accountNumber.replace(/\D/g, "");
  return digits.length >= 4 ? `${account.name} …${digits.slice(-4)}` : account.name;
}

const toInput = ({ name, kind, bank, accountNumber, statementName }: Account): AccountInput => ({
  name,
  kind,
  bank,
  accountNumber,
  statementName,
});

interface Props {
  accounts: Account[];
  /** Called after any change; transactions show account names, so they reload too. */
  onChanged: () => void;
}

/** Lists accounts with what's in them, and lets you add, edit, merge and delete them. */
export function AccountsPanel({ accounts, onChanged }: Props) {
  const [open, setOpen] = useState<{ id: number; mode: "edit" | "delete" } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>, failure: string) {
    try {
      await action();
      setError(null);
      setOpen(null);
      onChanged();
    } catch (err) {
      setError(`${failure}: ${(err as Error).message}`);
    }
  }

  const rename = (account: Account, name: string) => {
    if (!name.trim() || name.trim() === account.name) return;
    void run(() => updateAccount(account.id, { ...toInput(account), name }), `Couldn't rename "${account.name}"`);
  };
  const toggle = (id: number, mode: "edit" | "delete") =>
    setOpen((o) => (o?.id === id && o.mode === mode ? null : { id, mode }));

  return (
    <>
      <header className="page-head">
        <h1>Accounts</h1>
        <p className="muted">
          Statement PDFs find their account by bank, account number and the name printed on the statement, and create
          one if there's none. CSV downloads go into the account you choose.
        </p>
      </header>

      <section className="panel accounts">
        <AddAccount
          onAdded={() => {
            setError(null);
            onChanged();
          }}
          onError={setError}
        />
        {error && (
          <p className="status error" role="alert">
            {error}
          </p>
        )}

        <div className="table-scroll">
          <table className="category-table account-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Transactions</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <Fragment key={a.id}>
                  <tr className={open?.id === a.id ? `selected ${open.mode}` : undefined}>
                    <td>
                      <input
                        aria-label={`Name of ${a.name}`}
                        defaultValue={a.name}
                        key={a.name}
                        onBlur={(e) => rename(a, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") {
                            e.currentTarget.value = a.name;
                            e.currentTarget.blur();
                          }
                        }}
                      />
                      <div className="muted account-meta">{describeIdentity(a)}</div>
                    </td>
                    <td>
                      <KindSelect
                        label={`Type of ${a.name}`}
                        value={a.kind}
                        onChange={(kind) => void run(() => updateAccount(a.id, { ...toInput(a), kind }), `Couldn't update "${a.name}"`)}
                      />
                    </td>
                    <td className="muted">{describeActivity(a)}</td>
                    <td className="row-actions">
                      <button type="button" className="link" onClick={() => toggle(a.id, "edit")}>
                        Edit
                      </button>
                      <button type="button" className="link" onClick={() => toggle(a.id, "delete")}>
                        Delete
                      </button>
                    </td>
                  </tr>
                  {open?.id === a.id && (
                    <tr className={`selected ${open.mode}`}>
                      <td colSpan={4}>
                        {open.mode === "edit" ? (
                          <EditAccount
                            account={a}
                            onCancel={() => setOpen(null)}
                            onSave={(input) => void run(() => updateAccount(a.id, input), `Couldn't update "${a.name}"`)}
                          />
                        ) : (
                          <DeleteConfirm
                            account={a}
                            others={accounts.filter((o) => o.id !== a.id)}
                            onCancel={() => setOpen(null)}
                            onConfirm={(moveTo) => void run(() => deleteAccount(a.id, moveTo), `Couldn't delete "${a.name}"`)}
                          />
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No accounts yet. Import a statement PDF, or add one above for CSV downloads.
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

function describeIdentity(a: Account): string {
  const parts = [a.bank, a.accountNumber && `#${a.accountNumber}`].filter(Boolean);
  parts.push(a.statementName ? `statements: “${a.statementName}”` : "not matched to a statement yet");
  return parts.join(" · ");
}

function describeActivity(a: Account): string {
  if (a.transactionCount === 0) return "None yet";
  const count = `${a.transactionCount} ${a.transactionCount === 1 ? "transaction" : "transactions"}`;
  const range = a.firstDate === a.lastDate ? a.firstDate : `${a.firstDate} to ${a.lastDate}`;
  return `${count}, ${range}`;
}

function AddAccount({ onAdded, onError }: { onAdded: () => void; onError: (e: string) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AccountKind>("credit_card");
  return (
    <form
      className="add-category"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        createAccount({ name: name.trim(), kind, bank: "U.S. Bank", accountNumber: "" }).then(
          () => {
            setName("");
            onAdded();
          },
          (err: Error) => onError(`Couldn't add the account: ${err.message}`),
        );
      }}
    >
      <input aria-label="New account name" placeholder="New account, e.g. Visa" value={name} onChange={(e) => setName(e.target.value)} />
      <KindSelect value={kind} onChange={setKind} />
      <button type="submit" disabled={!name.trim()}>
        Add account
      </button>
    </form>
  );
}

function EditAccount({ account, onCancel, onSave }: { account: Account; onCancel: () => void; onSave: (input: AccountInput) => void }) {
  const [draft, setDraft] = useState(() => ({ ...toInput(account), statementName: account.statementName ?? "" }));
  const field = (key: "bank" | "accountNumber" | "statementName", label: string, help?: string) => (
    <label>
      {label}
      <input value={draft[key] ?? ""} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
      {help && <span className="muted">{help}</span>}
    </label>
  );
  return (
    <form
      className="account-edit"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...draft, statementName: draft.statementName?.trim() || null });
      }}
    >
      {field("bank", "Bank")}
      {field("accountNumber", "Account number", "As printed on statements")}
      {field("statementName", "Statement name", "Product name on PDF statements; leave empty to let the next matching PDF set it")}
      <div className="delete-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit">Save</button>
      </div>
    </form>
  );
}

function DeleteConfirm({
  account,
  others,
  onCancel,
  onConfirm,
}: {
  account: Account;
  others: Account[];
  onCancel: () => void;
  onConfirm: (moveTo: number | null) => void;
}) {
  const [moveTo, setMoveTo] = useState<number | null>(null);
  const count = account.transactionCount;
  return (
    <div className="delete-confirm">
      <p>
        Delete <strong>{account.name}</strong>?{" "}
        {count ? (
          <>
            It has {count} {count === 1 ? "transaction" : "transactions"}.
          </>
        ) : (
          <span className="muted">It has no transactions.</span>
        )}
      </p>
      {count > 0 && others.length > 0 && (
        <label>
          {"Move them to "}
          <select value={moveTo ?? ""} onChange={(e) => setMoveTo(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Nothing (delete them too)</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {accountLabel(o)}
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
          {moveTo === null && count > 0 ? `Delete account and ${count} transactions` : "Delete account"}
        </button>
      </div>
      {moveTo !== null && (
        <p className="muted">Transactions the other account already has (from an overlapping import) are dropped, not doubled.</p>
      )}
    </div>
  );
}

export function KindSelect({
  value,
  onChange,
  label = "Account type",
}: {
  value: AccountKind;
  onChange: (kind: AccountKind) => void;
  label?: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as AccountKind)}>
      {Object.entries(ACCOUNT_KIND_LABELS).map(([k, text]) => (
        <option key={k} value={k}>
          {text}
        </option>
      ))}
    </select>
  );
}
