/**
 * A typed price that is under half or over twice the list price is far more often a slip (3.00 typed into a $6.99
 * line, 60 for 6.00) than a deal. This is the one sentence both the order page's price edit (F14) and the Create
 * Order line (UX audit 2026-11-24 F32) show for it. Words only: nothing is blocked, nothing is rounded into a total.
 *
 * Returns null when there is nothing to say: no list price to compare with, a negative price, or a price inside the
 * half-to-double band (an ordinary discount or upsell, which each screen already marks in its own way).
 */
export function farFromListText(unitPrice: number, listPrice: number): string | null {
  if (!(listPrice > 0) || !(unitPrice >= 0)) return null;
  if (unitPrice >= listPrice * 0.5 && unitPrice <= listPrice * 2) return null;
  const list = `$${listPrice.toFixed(2)}`;
  return unitPrice < listPrice
    ? `${Math.round((1 - unitPrice / listPrice) * 100)}% below list (${list})`
    : `${Math.round((unitPrice / listPrice - 1) * 100)}% above list (${list})`;
}
