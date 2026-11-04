# Receipts: data model (draft)

Status: design draft, not implemented. The extraction approach (OCR library / hosted API / vision LLM)
is still open; this model is meant to be independent of it.

## Goals

1. Upload a receipt image (photo, screenshot, or PDF e-receipt) and keep the original.
2. Extract merchant, date, total, line items, tax/tip/discounts, and how it was paid.
3. Match the receipt to the transaction(s) it paid for, using the total, date, card last-4 and merchant.
4. Split the spending across categories by line item, so one Target run can be part groceries and part
   household.

## Key decisions

- **Every receipt line is signed, and the lines add up to the total.** Items, tax, tip and fees are positive;
  discounts and coupons are negative. `sum(receipt_lines.amount_cents) = receipts.total_cents` is the
  invariant that validation checks, the same way the statement parser checks section totals.
- **Tenders (payments), not receipts, match transactions.** A receipt has one or more payments (card, cash,
  gift card), and each card payment links to at most one transaction. This handles split tender (two cards,
  or cash plus card) without a many-to-many table, and a receipt with no extracted payment gets one
  synthetic payment for its total.
- **Categories go on lines; adjustments without a category are prorated.** Items get a category. Tax, tip,
  fees and order-level discounts may have one; if they don't, they are spread over the items in proportion
  to their amounts (tax only over items with the same tax code). A discount tied to a specific item
  (`applies_to_line_id`) goes to that item's category. This keeps "where did the money go" fully
  determined without making the user categorize the tax line.
- **The transaction's amount wins over the receipt's.** Restaurant receipts are printed before the tip, gas
  stations pre-authorize, and so on. The difference (`transaction amount − payment amount`) is stored on the
  match and treated as one more uncategorized adjustment, prorated like tax. Large differences are flagged
  for review rather than accepted.
- **Transactions can be itemized without a receipt.** Implemented in `002_transaction_items.sql`:
  `categories` plus `transaction_items` (description, signed amount, category), which either is empty or adds
  up to the transaction exactly. This is what spending reports read. Confirming a receipt match should
  write the receipt's per-category breakdown into `transaction_items` (marked as coming from the receipt), so
  manual and receipt itemizations look the same downstream. That replaces the `transactions.category_id` idea
  below; the `categories` table that already exists has no `parent_id` or `kind` yet.
- **Keep the raw extraction.** Store the extractor's output (`jsonb`), its name and version, and per-field
  confidence where available, so we can re-run a better extractor later and so the review UI can highlight
  low-confidence fields. User edits go into the normalized columns; the raw output is never edited.
- **Money in integer cents** like `transactions.amount_cents`. Unit prices can be fractional
  ($3.499/gal), so `unit_price_cents` is `numeric`; `amount_cents` on the line is authoritative.

## Schema (proposed `002_receipts.sql`)

```sql
CREATE TABLE categories (
  id         serial PRIMARY KEY,
  parent_id  integer REFERENCES categories (id),
  name       text NOT NULL,
  -- 'expense' | 'income' | 'transfer': transfers are excluded from spending reports.
  kind       text NOT NULL DEFAULT 'expense',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (parent_id, name)
);

ALTER TABLE transactions ADD COLUMN category_id integer REFERENCES categories (id);

-- Original uploads, kept apart from receipts so listing receipts doesn't read image bytes.
CREATE TABLE receipt_files (
  id           serial PRIMARY KEY,
  sha256       text NOT NULL UNIQUE,            -- re-uploading the same file is a no-op
  content_type text NOT NULL,                   -- image/jpeg, image/heic, application/pdf, ...
  file_name    text NOT NULL,
  data         bytea NOT NULL,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE receipts (
  id                  serial PRIMARY KEY,
  file_id             integer NOT NULL REFERENCES receipt_files (id),
  -- 'pending' (awaiting extraction) | 'extracted' (needs review) | 'reviewed' | 'failed'
  status              text NOT NULL DEFAULT 'pending',
  merchant_name       text,
  merchant_address    text,
  purchased_at        timestamptz,              -- or just a date when the receipt has no time
  purchase_date       date,
  currency            text NOT NULL DEFAULT 'USD',
  subtotal_cents      bigint,
  total_cents         bigint,
  -- Used for items the user hasn't categorized individually.
  default_category_id integer REFERENCES categories (id),
  -- Extractor output, verbatim, plus what produced it.
  extractor           text,                     -- e.g. 'claude-sonnet-5-5', 'textract-expense', 'paddleocr+rules'
  extractor_version   text,
  raw_extraction      jsonb,
  validation_issues   jsonb NOT NULL DEFAULT '[]',
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX receipts_purchase_date_idx ON receipts (purchase_date);

CREATE TABLE receipt_lines (
  id                 bigserial PRIMARY KEY,
  receipt_id         integer NOT NULL REFERENCES receipts (id) ON DELETE CASCADE,
  position           integer NOT NULL,          -- order printed on the receipt
  -- 'item' | 'discount' | 'tax' | 'tip' | 'fee' | 'deposit' (bottle deposit etc.)
  kind               text NOT NULL,
  description        text NOT NULL,             -- as printed, e.g. "GV 2% MILK GAL"
  display_name       text,                      -- user/LLM cleanup, e.g. "Great Value 2% milk, 1 gal"
  quantity           numeric(12, 3),            -- 2, or 1.37 (lb)
  unit               text,                      -- 'ea', 'lb', 'gal', ...
  unit_price_cents   numeric(14, 3),
  amount_cents       bigint NOT NULL,           -- signed; lines sum to receipts.total_cents
  sku                text,
  -- Tax code/flag printed beside the item ('T', 'N', 'A', ...) and on tax lines, so tax prorates
  -- only over the items it applied to.
  tax_code           text,
  applies_to_line_id bigint REFERENCES receipt_lines (id) ON DELETE CASCADE,  -- item-level discounts
  category_id        integer REFERENCES categories (id),
  confidence         real,                      -- 0..1 from the extractor, if it gives one
  bbox               jsonb,                     -- {page, x, y, w, h} normalized, if it gives one
  UNIQUE (receipt_id, position)
);

CREATE TABLE receipt_payments (
  id                 serial PRIMARY KEY,
  receipt_id         integer NOT NULL REFERENCES receipts (id) ON DELETE CASCADE,
  method             text NOT NULL,             -- 'card' | 'cash' | 'gift_card' | 'other' | 'unknown'
  card_brand         text,
  card_last4         text,
  amount_cents       bigint NOT NULL,           -- positive for a purchase, negative for a refund
  -- Matching. One transaction pays for at most one tender.
  transaction_id     bigint UNIQUE REFERENCES transactions (id) ON DELETE SET NULL,
  -- 'unmatched' | 'suggested' | 'confirmed' | 'rejected' | 'not_applicable' (cash)
  match_status       text NOT NULL DEFAULT 'unmatched',
  match_score        real,
  -- (-transaction.amount_cents) - amount_cents: tip added later, pre-auth differences, FX.
  amount_delta_cents bigint,
  matched_at         timestamptz
);
```

A rejected suggestion should not come back on the next matching run. If that matters early, add a small
`receipt_match_rejections (payment_id, transaction_id)` table; otherwise `match_status = 'rejected'` with the
transaction cleared is enough for one-candidate-at-a-time matching.

## Matching

Run after extraction and again after each statement import (receipts often arrive before the statement).
Candidates for a payment are debit transactions where:

| Signal | Rule | Weight |
| --- | --- | --- |
| Amount | `-amount_cents = payment.amount_cents`; or within tolerance for restaurants/gas (e.g. up to +30% for tip) | strongest |
| Date | `transaction_date` (card use date) within ±1 day of `purchase_date`, else `posted_date` within 0..5 days after | strong |
| Card | `card_last4` equal (when both known) | strong; a mismatch rules it out |
| Merchant | fuzzy match of `merchant_name` against `description`/`details` (normalized, e.g. trigram) | tie-breaker |

One clear winner above a threshold becomes `suggested`; the user confirms in the UI. Auto-confirming exact
amount + card + date can come later.

## Spending by category

Per confirmed receipt, the amount attributed to each category is:

1. Each item's `amount_cents`, plus discounts whose `applies_to_line_id` is that item, goes to the item's
   `category_id` (or `receipts.default_category_id`, or the transaction's category).
2. Adjustment lines with their own `category_id` go there.
3. The remaining adjustment lines (tax by `tax_code`, other adjustments over all items) and the match's
   `amount_delta_cents` are prorated over the items by amount, with rounding remainders given to the
   largest item so the categories add up to the transaction exactly.

This is easiest to do in TypeScript (one function, unit-tested like `fingerprint.ts`) and expose through
the API; a SQL view can come later if reports need it.

## Extraction output (provider-independent)

Whatever extractor we choose returns this, and the API maps it into the tables above:

```ts
interface ReceiptExtraction {
  merchant: { name: string | null; address: string | null; phone: string | null };
  purchasedAt: { date: IsoDate | null; time: string | null };
  currency: string | null;
  subtotal: number | null;
  total: number | null;
  lines: {
    kind: "item" | "discount" | "tax" | "tip" | "fee" | "deposit";
    description: string;
    quantity: number | null;
    unit: string | null;
    unitPrice: number | null;
    amount: number;               // signed dollars, same convention as the parser
    sku: string | null;
    taxCode: string | null;
    appliesToIndex: number | null; // index of the item a discount belongs to
    suggestedCategory: string | null;
    confidence: number | null;
    bbox: { page: number; x: number; y: number; w: number; h: number } | null;
  }[];
  payments: { method: string; cardBrand: string | null; cardLast4: string | null; amount: number }[];
}
```

## Open questions

- Which extractor. Research (2026-11) points to a vision LLM with schema-constrained JSON output. Options:
  a local model (e.g. Qwen3-VL ~8B via Ollama/vLLM as a chart sidecar) for privacy, Claude Haiku/Sonnet as
  an opt-in fallback for receipts that fail validation, and Azure `prebuilt-receipt` if native per-field
  confidence and bounding boxes matter. PDF e-receipts with a text layer skip OCR via `pdfjs-dist`. LLMs
  don't give confidence or boxes, so `confidence`/`bbox` stay nullable and the arithmetic checks act as the
  confidence signal.
- Image storage: `bytea` in Postgres is simplest for a self-hosted app at personal scale and is covered by
  database backups; move to a PVC or object storage if the database gets large.
- HEIC from iPhones: convert on upload (e.g. `sharp`) or require the extractor to accept it.
- Returns/refunds: a refund receipt is the same model with negative amounts. Should it link back to the
  original receipt's lines?
- Seed a default category tree, or start empty?
- When a receipt is matched to a transaction that was already itemized by hand, should the receipt replace
  those items or ask first?
