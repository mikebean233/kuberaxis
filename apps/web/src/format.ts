const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const formatAmount = (amount: number) => currency.format(amount);

/** "2026-09-11" -> "Sep 11, 2026", without shifting the date through a timezone. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
