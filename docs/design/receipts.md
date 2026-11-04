# Receipts: data model

Status: the data model is built (`apps/api/migrations/004_receipts.sql`, `apps/api/src/receipts.ts`), with no
API routes or UI yet. Still to build: upload, extraction, matching, and writing confirmed receipts into
`transaction_items`. The extractor is still open; the model doesn't depend on it.

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
  stations pre-authorize, and so on. The difference (`transaction amount − payment amount`) is computed by the
  `receipt_payment_matches` view rather than stored, so it can't go stale, and is treated as one more
  uncategorized adjustment, prorated like tax. Large differences are flagged for review rather than accepted.
- **Receipts feed `transaction_items`.** Transactions can already be itemized by hand (`transaction_items`,
  which is either empty or adds up to the transaction exactly), and that is what spending reports read.
  Confirming a receipt match writes the receipt's per-category breakdown there, with
  `transaction_items.receipt_id` set, so manual and receipt itemizations look the same downstream.
- **Keep the raw extraction.** Store the extractor's output (`jsonb`), its name and version, and per-field
  confidence where available, so we can re-run a better extractor later and so the review UI can highlight
  low-confidence fields. User edits go into the normalized columns; the raw output is never edited.
- **Money in integer cents** like `transactions.amount_cents`. Unit prices can be fractional
  ($3.499/gal), so `unit_price_cents` is `numeric`; `amount_cents` on the line is authoritative.

## Schema

Implemented in `apps/api/migrations/004_receipts.sql`; read that for the columns. In summary:

| Table | Holds |
| --- | --- |
| `receipt_files` | The uploaded bytes, unique by SHA-256 so re-uploading finds the existing receipt |
| `receipts` | Status (`pending` → `extracted` → `reviewed`, or `failed`), merchant, date and time, subtotal, total, default category, the extractor's raw output and name, and `validation_issues` |
| `receipt_lines` | Signed lines in printed order: kind, description, quantity, unit price, amount, tax code, category, and the extractor's confidence and bounding box |
| `receipt_payments` | How it was paid (method, card brand and last 4, amount) and its match: `transaction_id`, `match_status`, score |
| `receipt_match_rejections` | Suggestions the user turned down, so matching doesn't propose them again |
| `receipt_payment_matches` (view) | Matched payments with `amount_delta_cents`, the transaction minus the receipt |

What the database enforces:

- Every status, kind and payment method is one of the listed values.
- An item-level discount (`applies_to_line_id`) points at a line on the same receipt (composite foreign key),
  and only discounts can point at another line.
- A payment is `suggested` or `confirmed` exactly when it has a `transaction_id`, and a transaction matches
  at most one payment.
- Deleting a receipt deletes its lines, payments and rejections; items it wrote into `transaction_items` stay,
  with `receipt_id` cleared, as if entered by hand.
- That the lines add up to the total is *not* enforced, since extraction is imperfect: `validateExtraction`
  records mismatches in `validation_issues` for review instead.

Changes from the earlier draft: categories and `transactions.category_id` already existed (from the
categories work), so they aren't redefined; categories stay flat (no `parent_id`); the amount difference is a
view instead of a stored column; rejections got their own table now rather than later; and a payment's
transaction can't be deleted out from under it (purging transactions clears receipts too).

`apps/api/src/receipts.ts` has the data access: `createReceipt` stores a file (once per content) and a pending
receipt; `saveExtraction` writes a `ReceiptExtraction` into the tables, matches suggested category names to
existing categories, links item discounts, adds a stand-in `unknown` payment when none was found, and refuses
receipts that are reviewed or matched; `getReceipt` reads one back.

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

Whatever extractor we choose returns this (`ReceiptExtraction` in `apps/api/src/types.ts`), and
`saveExtraction` maps it into the tables above:

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
