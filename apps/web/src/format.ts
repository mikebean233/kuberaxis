const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const formatAmount = (amount: number) => currency.format(amount);

/** "2026-09-11" -> "Sep 11, 2026", without shifting the date through a timezone. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export const formatCents = (cents: number) => currency.format(cents / 100);

/** Parses a typed dollar amount ("12", "-3.5", "$1,204.99") into cents; null if it isn't one. */
export function parseCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^-?(\d+\.?\d{0,2}|\.\d{1,2})$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}
