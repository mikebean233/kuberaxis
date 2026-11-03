import { createHash } from "node:crypto";
import type { Transaction } from "@kuberaxis/parser";

export const toCents = (dollars: number) => Math.round(dollars * 100);

/**
 * Identifies a transaction independently of which statement (or import) it came from.
 * Section and page are left out because they describe statement layout, not the transaction.
 */
export function fingerprint(t: Transaction): string {
  const key = [t.date, toCents(t.amount), t.type, t.description, t.details, t.refNumber, t.cardLast4];
  return createHash("sha256").update(JSON.stringify(key)).digest("hex");
}

/**
 * Pairs each transaction with its fingerprint and its 1-based occurrence among identical
 * transactions in the same list. Because occurrences are counted the same way on every
 * import, re-importing a statement maps each row onto the row it created the first time.
 */
export function withOccurrences(transactions: Transaction[]): { transaction: Transaction; fingerprint: string; occurrence: number }[] {
  const seen = new Map<string, number>();
  return transactions.map((transaction) => {
    const fp = fingerprint(transaction);
    const occurrence = (seen.get(fp) ?? 0) + 1;
    seen.set(fp, occurrence);
    return { transaction, fingerprint: fp, occurrence };
  });
}
