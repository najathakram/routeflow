import { barcodeRowsToView, synthesizeLegacyBarcodes } from "./product-barcode-rules";
import { tenantSafeParent } from "./product-parent";

/**
 * The product shape the counter scan lookup answers with (`ProductsService.findByBarcode`, via
 * `findScanMatches`), kept in ONE place so a second reader of "a product as the scan returns it" (the counter
 * QUICK KEYS grid, SA-747r) cannot grow a second shape (L-167).
 *
 * `scanReadInclude` is the relation include the scan reads with: only THIS tenant's active variants and the
 * parent row (B1211: a cross-tenant link is dropped on read by `tenantSafeParent`). `findScanMatches` adds
 * `barcodes: true` on top; `toScanProductView` is the mapping applied to a row read with `{ ...include,
 * barcodes: true }`: the barcode view (rows, else the legacy synthesised ones) and the tenant-safe parent.
 * `scanMatch` is NOT part of it: that is the answer to a scanned code, which a grid key has none of.
 */
export function scanReadInclude(tenantId: string | null | undefined) {
  return {
    variants: { where: { isActive: true, ...(tenantId ? { tenantId } : {}) } },
    parent: true,
  };
}

type ScanRow = {
  barcode: string | null;
  unitsPerBox: number | null;
  barcodes?: unknown[] | null;
  parent?: { tenantId?: string | null } | null;
};

export function toScanProductView<T extends ScanRow>(row: T, tenantId: string | null | undefined) {
  const own = Array.isArray(row.barcodes) ? row.barcodes : [];
  return {
    ...row,
    barcodes: own.length
      ? barcodeRowsToView(own as Parameters<typeof barcodeRowsToView>[0])
      : synthesizeLegacyBarcodes(row),
    parent: tenantSafeParent(row.parent, tenantId),
  };
}
