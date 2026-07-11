import type { ScanResult } from "./api/vendor-bills";

/**
 * Pure (screen-free, testable) helpers for the vendor-bill scan flow — turn an AI
 * ScanResult into the create-bill DTO and the learned product mappings. Kept out of
 * the RN screens so `apps/mobile/__tests__/*.test.ts` (pure-logic, node env) can
 * lock the API-field mapping (extractedName→description, matchedProductId→productId,
 * invoiceDate→billDate) that the screen previously got wrong.
 */

export interface SupplierRef {
  id: string;
  name: string;
}

export interface ScanBillItemDto {
  description: string;
  productId?: string;
  qty: number;
  unitCost: number;
}

export interface ScanBillDto {
  supplierId?: string;
  billDate?: string;
  notes?: string;
  items: ScanBillItemDto[];
}

export interface ScanProductMapping {
  supplierName: string;
  rawDescription: string;
  productId: string;
}

/** Build the POST /vendor-bills DTO from a scan result. Lines with neither a
 * quantity nor a cost are dropped (blank AI rows); everything else is kept even
 * when unmatched (`productId` omitted) so the bill can be linked later. */
export function buildBillDtoFromScan(
  result: ScanResult,
  suppliers: SupplierRef[] | undefined,
): ScanBillDto {
  const supplierName = (result.supplier ?? "").trim();
  const matchedSupplier = supplierName
    ? suppliers?.find((s) => s.name.toLowerCase() === supplierName.toLowerCase())
    : undefined;

  return {
    supplierId: matchedSupplier?.id,
    billDate: result.invoiceDate ?? undefined,
    notes: supplierName ? `AI scanned from ${supplierName}` : undefined,
    items: (result.items ?? [])
      .filter((i) => (i.qty ?? 0) > 0 || (i.unitCost ?? 0) > 0)
      .map((i) => ({
        description: i.extractedName,
        productId: i.matchedProductId ?? undefined,
        qty: i.qty ?? 1,
        unitCost: i.unitCost ?? 0,
      })),
  };
}

/** Mappings to persist so the AI matcher learns — one per line that ended up
 * linked to a product. Requires a supplier name (the mapping key on the server). */
export function mappingsFromScan(result: ScanResult): ScanProductMapping[] {
  const supplierName = (result.supplier ?? "").trim();
  if (!supplierName) return [];
  return (result.items ?? [])
    .filter((i) => !!i.matchedProductId && !!i.extractedName)
    .map((i) => ({
      supplierName,
      rawDescription: i.extractedName,
      productId: i.matchedProductId as string,
    }));
}
