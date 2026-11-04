-- Receipts: the uploaded file, what was read from it (lines and payments), and how its payments match
-- transactions. See docs/design/receipts.md.

-- Original uploads, kept apart from receipts so listing receipts doesn't read image bytes.
CREATE TABLE receipt_files (
  id           serial PRIMARY KEY,
  -- Re-uploading the same file finds the existing row.
  sha256       text NOT NULL UNIQUE,
  content_type text NOT NULL,                   -- image/jpeg, image/heic, application/pdf, ...
  file_name    text NOT NULL,
  byte_size    integer NOT NULL CHECK (byte_size > 0),
  data         bytea NOT NULL,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE receipts (
  id                  serial PRIMARY KEY,
  file_id             integer NOT NULL REFERENCES receipt_files (id),
  -- 'pending': awaiting extraction. 'extracted': read, needs review. 'reviewed': checked by the user.
  -- 'failed': extraction didn't work (see validation_issues).
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'extracted', 'reviewed', 'failed')),
  merchant_name       text,
  merchant_address    text,
  merchant_phone      text,
  purchase_date       date,
  -- Time of day as printed, when the receipt shows one.
  purchase_time       time,
  currency            text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_cents      bigint,
  -- Lines are expected to add up to this; mismatches are recorded in validation_issues, not rejected,
  -- since extraction is imperfect and the user fixes them in review.
  total_cents         bigint,
  -- For items without a category of their own.
  default_category_id integer REFERENCES categories (id) ON DELETE SET NULL,
  -- Extractor output, verbatim and never edited, plus what produced it. Edits go into the columns.
  extractor           text,                     -- e.g. 'claude-haiku-5-5', 'azure-prebuilt-receipt', 'manual'
  extractor_version   text,
  raw_extraction      jsonb,
  validation_issues   jsonb NOT NULL DEFAULT '[]',
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX receipts_purchase_date_idx ON receipts (purchase_date);
CREATE INDEX receipts_file_idx ON receipts (file_id);

-- What the receipt lists, in printed order. Amounts are signed so the lines add up to the total: items,
-- tax, tips, fees and deposits are positive; discounts and coupons negative.
CREATE TABLE receipt_lines (
  id                 bigserial PRIMARY KEY,
  receipt_id         integer NOT NULL REFERENCES receipts (id) ON DELETE CASCADE,
  position           integer NOT NULL CHECK (position > 0),
  kind               text NOT NULL CHECK (kind IN ('item', 'discount', 'tax', 'tip', 'fee', 'deposit')),
  description        text NOT NULL,             -- as printed, e.g. "GV 2% MILK GAL"
  display_name       text,                      -- cleaned up, e.g. "Great Value 2% milk, 1 gal"
  quantity           numeric(12, 3),            -- 2, or 1.37 (lb)
  unit               text,                      -- 'ea', 'lb', 'gal', ...
  -- Can be fractional ($3.499/gal); amount_cents is what counts.
  unit_price_cents   numeric(14, 3),
  amount_cents       bigint NOT NULL,
  sku                text,
  -- Tax flag printed beside items ('T', 'N', 'A', ...) and on tax lines, so tax is spread only over
  -- the items it applied to.
  tax_code           text,
  -- A discount that belongs to one item. The composite key keeps it on the same receipt.
  applies_to_line_id bigint,
  -- Where the line's money goes. NULL on an item falls back to the receipt's default category; NULL on
  -- tax, tips, fees and order-level discounts means "spread over the items".
  category_id        integer REFERENCES categories (id) ON DELETE SET NULL,
  -- From the extractor, when it provides them, for highlighting uncertain fields during review.
  confidence         real CHECK (confidence BETWEEN 0 AND 1),
  bbox               jsonb,                     -- {page, x, y, w, h}, normalized 0..1
  UNIQUE (receipt_id, position),
  UNIQUE (receipt_id, id),
  FOREIGN KEY (receipt_id, applies_to_line_id) REFERENCES receipt_lines (receipt_id, id) ON DELETE CASCADE,
  CHECK (applies_to_line_id IS NULL OR kind = 'discount'),
  CHECK (applies_to_line_id IS DISTINCT FROM id)
);

CREATE INDEX receipt_lines_category_idx ON receipt_lines (category_id);

-- How the receipt was paid. Payments, not receipts, match transactions: a receipt paid with two cards
-- matches two transactions, and a receipt with no payment found gets one 'unknown' payment for its total.
CREATE TABLE receipt_payments (
  id             serial PRIMARY KEY,
  receipt_id     integer NOT NULL REFERENCES receipts (id) ON DELETE CASCADE,
  method         text NOT NULL CHECK (method IN ('card', 'cash', 'gift_card', 'other', 'unknown')),
  card_brand     text,
  card_last4     text CHECK (card_last4 ~ '^[0-9]{4}$'),
  -- Positive for a purchase, negative for a refund (the opposite sign of the matching transaction).
  amount_cents   bigint NOT NULL,
  -- At most one payment per transaction.
  transaction_id bigint UNIQUE REFERENCES transactions (id),
  -- 'unmatched': no match yet. 'suggested': the matcher proposed transaction_id. 'confirmed': the user
  -- accepted it. 'not_applicable': nothing to match (cash).
  match_status   text NOT NULL DEFAULT 'unmatched'
                 CHECK (match_status IN ('unmatched', 'suggested', 'confirmed', 'not_applicable')),
  match_score    real,
  matched_at     timestamptz,
  CHECK ((transaction_id IS NOT NULL) = (match_status IN ('suggested', 'confirmed')))
);

CREATE INDEX receipt_payments_receipt_idx ON receipt_payments (receipt_id);

-- Suggestions the user turned down, so matching doesn't propose them again.
CREATE TABLE receipt_match_rejections (
  payment_id     integer NOT NULL REFERENCES receipt_payments (id) ON DELETE CASCADE,
  transaction_id bigint NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  rejected_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (payment_id, transaction_id)
);

-- Items written from a confirmed receipt carry it, so they can be told apart from manual ones and
-- rewritten when the receipt is edited. Deleting the receipt keeps the items as if entered by hand.
ALTER TABLE transaction_items ADD COLUMN receipt_id integer REFERENCES receipts (id) ON DELETE SET NULL;

-- Matched payments with how far the transaction is from the receipt: a tip added after printing, a
-- pre-authorization, or currency conversion. Computed, so it can't go stale if either side changes.
CREATE VIEW receipt_payment_matches AS
SELECT p.id AS payment_id,
       p.receipt_id,
       p.transaction_id,
       p.match_status,
       p.amount_cents,
       -t.amount_cents AS transaction_amount_cents,
       -t.amount_cents - p.amount_cents AS amount_delta_cents
FROM receipt_payments p
JOIN transactions t ON t.id = p.transaction_id;
