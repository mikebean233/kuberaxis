import type { Transaction } from "@kuberaxis/parser";
import { describe, expect, it } from "vitest";
import { fingerprint, withOccurrences } from "../src/fingerprint.js";

const txn = (overrides: Partial<Transaction> = {}): Transaction => ({
  date: "2026-09-12",
  section: "Card Withdrawals",
  type: "Debit Purchase - VISA",
  description: "On 091126 SEATTLE WA",
  details: ["COFFEE SHOP"],
  refNumber: null,
  amount: -4.5,
  transactionDate: "2026-09-11",
  cardLast4: "1234",
  page: 3,
  ...overrides,
});

describe("fingerprint", () => {
  it("ignores statement layout fields", () => {
    expect(fingerprint(txn({ page: 9, section: "Other Withdrawals" }))).toBe(fingerprint(txn()));
  });

  it("distinguishes transactions that differ in identifying fields", () => {
    const base = fingerprint(txn());
    expect(fingerprint(txn({ amount: -4.51 }))).not.toBe(base);
    expect(fingerprint(txn({ date: "2026-09-13" }))).not.toBe(base);
    expect(fingerprint(txn({ details: ["OTHER SHOP"] }))).not.toBe(base);
    expect(fingerprint(txn({ cardLast4: "9999" }))).not.toBe(base);
  });
});

describe("withOccurrences", () => {
  it("numbers identical transactions so both are kept", () => {
    const result = withOccurrences([txn(), txn({ amount: -10 }), txn()]);
    expect(result.map((r) => r.occurrence)).toEqual([1, 1, 2]);
    expect(result[0]!.fingerprint).toBe(result[2]!.fingerprint);
  });
});
