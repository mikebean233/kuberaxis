CREATE TABLE accounts (
  id             serial PRIMARY KEY,
  bank           text NOT NULL,
  -- As printed on the statement (often masked); '' when the statement doesn't show one.
  account_number text NOT NULL DEFAULT '',
  name           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank, account_number, name)
);

CREATE TABLE imports (
  id                serial PRIMARY KEY,
  file_name         text NOT NULL,
  file_sha256       text NOT NULL,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  parsed_count      integer NOT NULL DEFAULT 0,
  inserted_count    integer NOT NULL DEFAULT 0,
  skipped_count     integer NOT NULL DEFAULT 0,
  validation_issues jsonb NOT NULL DEFAULT '[]',
  imported_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id               bigserial PRIMARY KEY,
  account_id       integer NOT NULL REFERENCES accounts (id),
  import_id        integer NOT NULL REFERENCES imports (id),
  posted_date      date NOT NULL,
  transaction_date date,
  section          text NOT NULL,
  type             text NOT NULL,
  description      text NOT NULL,
  details          text[] NOT NULL DEFAULT '{}',
  ref_number       text,
  card_last4       text,
  amount_cents     bigint NOT NULL,
  -- Hash of the fields that identify a transaction (see src/fingerprint.ts).
  fingerprint      text NOT NULL,
  -- 1-based index among same-fingerprint transactions in one statement, so two genuinely
  -- identical charges on the same day are both kept while re-imports are still skipped.
  occurrence       integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, fingerprint, occurrence)
);

CREATE INDEX transactions_posted_date_idx ON transactions (posted_date);
