/**
 * SA-814 R5-2: a stored invoice header that AGREES with its lines, for specs that hand a service an invoice
 * to re-price or re-save. The recompute paths refuse (409 INVOICE_TAX_STATE_STALE) a header whose
 * `taxAmount` the stored lines cannot reproduce, so a fixture without a coherent header never reaches its
 * own assertions. Plain cent arithmetic on purpose: it must not call the production totals builder.
 */
const cents = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number => Number(v ?? 0);

export function storedInvoiceHeader(
  lines: ReadonlyArray<{ subtotal?: unknown; taxRate?: unknown; categoryTaxAmount?: unknown }>,
  opts: { discount?: number; shippingFee?: number } = {},
): {
  discount: number;
  shippingFee: number;
  subtotal: number;
  taxAmount: number;
  total: number;
} {
  const discount = opts.discount ?? 0;
  const shippingFee = opts.shippingFee ?? 0;
  const subtotal = cents(lines.reduce((s, l) => s + num(l.subtotal), 0));
  const regular = cents(lines.reduce((s, l) => s + num(l.subtotal) * num(l.taxRate), 0));
  const levy = cents(lines.reduce((s, l) => s + num(l.categoryTaxAmount), 0));
  const taxAmount = cents(regular + levy);
  return {
    discount,
    shippingFee,
    subtotal,
    taxAmount,
    total: cents(subtotal - discount + shippingFee + taxAmount),
  };
}
