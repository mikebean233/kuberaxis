CREATE TABLE categories (
  id         serial PRIMARY KEY,
  name       text NOT NULL CHECK (btrim(name) <> ''),
  -- How money in this category counts: 'expense' is spending (a refund in it reduces spending), 'income' is
  -- money earned, and 'transfer' is money moving between your own accounts, counted as neither.
  kind       text NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income', 'transfer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX categories_name_key ON categories (lower(name));

-- A transaction broken down into what it paid for. Either a transaction has no items, or its items'
-- amounts add up to its amount exactly (enforced by the API; see src/transactionItems.ts).
CREATE TABLE transaction_items (
  id             bigserial PRIMARY KEY,
  transaction_id bigint NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  position       integer NOT NULL,
  description    text NOT NULL,
  -- Same sign convention as transactions.amount_cents: a purchase's items are negative, and a
  -- discount or return within it is positive.
  amount_cents   bigint NOT NULL,
  category_id    integer REFERENCES categories (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, position)
);

CREATE INDEX transaction_items_category_idx ON transaction_items (category_id);

-- Starter categories. Existing categories with the same name (ignoring case) are left as they are.
INSERT INTO categories (name, kind)
VALUES
  -- Food
  ('Groceries', 'expense'),
  ('Restaurants', 'expense'),
  ('Fast Food', 'expense'),
  ('Coffee', 'expense'),
  -- Home
  ('Mortgage', 'expense'),
  ('Utilities', 'expense'),
  ('Internet & Phone', 'expense'),
  ('Home Improvement', 'expense'),
  ('Home Maintenance', 'expense'),
  ('Furniture & Decor', 'expense'),
  ('Household Supplies', 'expense'),
  -- Transportation
  ('Fuel', 'expense'),
  ('Auto Maintenance', 'expense'),
  ('Auto Insurance', 'expense'),
  ('Vehicle Registration', 'expense'),
  -- Personal and family
  ('Health & Medical', 'expense'),
  ('Pets', 'expense'),
  ('Clothing', 'expense'),
  ('Shopping', 'expense'),
  ('Electronics', 'expense'),
  ('Hobbies', 'expense'),
  ('Entertainment', 'expense'),
  ('Streaming', 'expense'),
  ('Software & Subscriptions', 'expense'),
  ('Travel', 'expense'),
  ('Gifts & Donations', 'expense'),
  -- Obligations
  ('Student Loans', 'expense'),
  ('Taxes', 'expense'),
  ('Fees', 'expense'),
  -- Money moving between your own accounts rather than being spent
  ('Credit Card Payment', 'transfer'),
  ('Investments', 'transfer'),
  ('Transfers', 'transfer'),
  ('Cash', 'expense'),
  -- Money in
  ('Paycheck', 'income'),
  ('Interest', 'income'),
  ('Refunds', 'expense')
ON CONFLICT ((lower(name))) DO NOTHING;
