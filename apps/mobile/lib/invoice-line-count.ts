/**
 * Row 440: what the New-invoice header and footer count. A boxed line of 24 pieces is ONE item on
 * the invoice, so the label counts LINES (catalog and unlisted) that carry a quantity; the piece total
 * stays the gate for Create. Pure (no React) so Jest can test it.
 */
export function invoiceLineCount(
  catalogQtys: readonly number[],
  unlisted: readonly { qty: number }[],
): number {
  return catalogQtys.filter((q) => q > 0).length + unlisted.filter((u) => u.qty > 0).length;
}

export const lineCountLabel = (n: number): string => `${n} item${n === 1 ? "" : "s"}`;
