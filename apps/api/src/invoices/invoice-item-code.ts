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

export type InvoiceBarcodeSource = "line" | "pieces" | "none";

/**
 * SA-1031 r2: which barcodes a composed (mixed-pack) invoice line prints. The box or the pieces, never both.
 * First hit wins:
 *  1. the tenant turned barcodes off (`invoice.hideBarcodes`) -> none;
 *  2. a plain line (no components) -> line, today's chain;
 *  3. a pack with its own scan code (`unitSku ?? barcode`, non-empty; the item number `sku` alone does not count) -> line,
 *     and every piece prints no barcode;
 *  4. no pack code, and some piece has a frozen `unitBarcode` -> pieces, and the line prints no Code128;
 *  5. no pack code and no piece barcode -> line (the item number), so the line keeps the one code it prints today.
 */
export function invoiceBarcodeSource(
  product:
    { unitSku?: string | null; barcode?: string | null; sku?: string | null } | null | undefined,
  components: ReadonlyArray<{ unitBarcode?: string | null }> | null | undefined,
  showBarcodes: boolean,
): InvoiceBarcodeSource {
  if (!showBarcodes) return "none";
  if (!components || components.length === 0) return "line";
  if (product?.unitSku || product?.barcode) return "line";
  return components.some((c) => !!c.unitBarcode) ? "pieces" : "line";
}
