-- Accounts become something the user manages: a name and type they choose, separate from how a statement
-- identifies the account. PDF imports match on (bank, account_number, statement_name); CSV imports name the
-- account explicitly, since a CSV doesn't say which account it's from.

ALTER TABLE accounts DROP CONSTRAINT accounts_bank_account_number_name_key;
ALTER TABLE accounts RENAME COLUMN name TO statement_name;
-- NULL for accounts created by hand (or for CSVs) that no statement has matched yet.
ALTER TABLE accounts ALTER COLUMN statement_name DROP NOT NULL;
ALTER TABLE accounts ALTER COLUMN bank SET DEFAULT '';

ALTER TABLE accounts ADD COLUMN name text;
UPDATE accounts SET name = statement_name;
ALTER TABLE accounts ALTER COLUMN name SET NOT NULL;
ALTER TABLE accounts ADD CONSTRAINT accounts_name_not_blank CHECK (btrim(name) <> '');

ALTER TABLE accounts ADD COLUMN kind text NOT NULL DEFAULT 'other'
  CHECK (kind IN ('checking', 'savings', 'credit_card', 'other'));
UPDATE accounts SET kind = CASE
  WHEN statement_name ILIKE '%CHECKING%' THEN 'checking'
  WHEN statement_name ILIKE '%SAVINGS%' OR statement_name ILIKE '%MONEY MARKET%' THEN 'savings'
  WHEN statement_name ILIKE '%CREDIT CARD%' OR statement_name ILIKE '%VISA%' THEN 'credit_card'
  ELSE 'other'
END;

-- Accounts only ever filled from CSV downloads weren't named by a statement.
UPDATE accounts a SET statement_name = NULL
WHERE NOT EXISTS (
  SELECT 1 FROM transactions t JOIN imports i ON i.id = t.import_id
  WHERE t.account_id = a.id AND i.file_name !~* '\.csv$'
);

CREATE UNIQUE INDEX accounts_statement_key ON accounts (bank, account_number, statement_name)
  WHERE statement_name IS NOT NULL;
CREATE INDEX transactions_account_idx ON transactions (account_id);

-- Which accounts each import covered, with per-account counts. A statement PDF can hold several accounts
-- (checking and savings), so this is a link table rather than a column on imports.
CREATE TABLE import_accounts (
  import_id         integer NOT NULL REFERENCES imports (id) ON DELETE CASCADE,
  account_id        integer NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  parsed_count      integer NOT NULL DEFAULT 0,
  inserted_count    integer NOT NULL DEFAULT 0,
  skipped_count     integer NOT NULL DEFAULT 0,
  validation_issues jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (import_id, account_id)
);

CREATE INDEX import_accounts_account_idx ON import_accounts (account_id);

-- Earlier imports: rebuilt from the transactions each one inserted. Rows an import skipped as already
-- imported weren't recorded, so those counts start at what's known.
INSERT INTO import_accounts (import_id, account_id, parsed_count, inserted_count)
SELECT import_id, account_id, count(*), count(*)
FROM transactions
GROUP BY import_id, account_id;
