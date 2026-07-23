/**
 * Code printed under each invoice line's Code128. Customer invoices show the
 * UNIT (retail) code — retailers scan the inner piece, not the case. Falls back
 * to the legacy barcode→sku chain when no unit code is set.
 */
export function invoiceItemCode(
  p?: { unitSku?: string | null; barcode?: string | null; sku?: string | null } | null,
): string | null {
  return p?.unitSku ?? p?.barcode ?? p?.sku ?? null;
}
