/**
 * B661: the product's `unitsPerBox` AS OF THIS WRITE, for `writeSaleEntries`'s `packAtSale` — a
 * fresh read at the write, never a later one. `InvoiceItem.unitsPerBox` is only ever snapshotted
 * for a box-SPLIT line (schema comment), so a box-unaware line's own field is null and this is
 * the only way `regulatedUnitBasis`'s write-time fallback (branch 4) can see a pack at all. A
 * product not found (deleted / bad id) is simply absent from the map — `packAtSale` comes back
 * `undefined` for it, which the pricing function treats as "no pack" (never a wrong guess).
 *
 * Own module (not a private method on InvoicesService) per the repo's size ratchet
 * (`common/size-ratchet.spec.ts`) — invoices.service.ts is one of the 15 tracked giants and this
 * is a self-contained, stateless slice.
 */
export async function packAtSaleByProduct(
  db: any,
  items: { productId?: string | null }[],
): Promise<Map<string, number>> {
  const ids = [...new Set(items.map((i) => i.productId).filter(Boolean))] as string[];
  if (ids.length === 0) return new Map();
  const products = await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, unitsPerBox: true },
  });
  return new Map(products.map((p: any) => [p.id, Number(p.unitsPerBox ?? 0)]));
}

/**
 * B661: the one shared `SaleLedgerLine[]` builder for all three `writeSaleEntries` callers in
 * invoices.service.ts (create's manual path, createSplitInvoices, resyncInvoiceLedger) — they
 * built byte-identical shapes off their own `items` array, so this is the actual DRY, not just a
 * line-count move. `packMap` comes from `packAtSaleByProduct` above, read once per write.
 */
export function toSaleLedgerLines(items: any[], packMap: Map<string, number>) {
  return items.map((it: any) => ({
    invoiceItemId: it.id,
    orderItemId: it.orderItemId ?? null,
    trackedCategoryId: it.trackedCategoryId ?? null,
    trackedSubcategoryId: it.trackedSubcategoryId ?? null,
    qty: Number(it.qty),
    boxes: it.boxes ?? null,
    pieces: it.pieces ?? null,
    unitsPerBox: it.unitsPerBox ?? null,
    unitLabel: it.unitLabel ?? null,
    packAtSale: it.productId ? (packMap.get(it.productId) ?? null) : null,
    netSales: Number(it.subtotal),
    categoryTax: Number(it.categoryTaxAmount ?? 0),
  }));
}
