# Agent guidelines

## No real data in tests or test data

Statements and exports from real accounts may be shared for debugging (e.g. a redacted PDF in the repo root). Use them only to understand a layout — never copy anything from them into tests, fixtures, `test-data/`, sample-generation scripts, or code comments. That includes:

- names, addresses, phone numbers, emails
- account, card, check, reference and routing numbers (including last-four digits)
- amounts and balances
- dates and statement periods
- merchant names, memos and transaction descriptions
- the specific account products a person holds

Reproduce the layout with fictional values instead (round amounts, placeholder numbers like `1234`/`5678`, names like `ALEX SAMPLE`, the sample statement's period). Keep only what the parser depends on: labels, headings, column positions and formatting.

Don't commit real statements or exports.
