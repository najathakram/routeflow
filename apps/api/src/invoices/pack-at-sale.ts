import { Logger } from "@nestjs/common";
import { finiteStoredLevy, finiteStoredMoney } from "../common/money-invariants.util";

const logger = new Logger("packAtSale");

/**
 * B700 (SA-062): the LIVE product's `unitsPerBox`, read fresh at the write — the FALLBACK
 * `packAtSale` source for a line with no snapshot of its own (a manual/freeform invoice line, or
 * an invoice item written before the snapshot shipped). `toSaleLedgerLines` below always prefers
 * the line's OWN `unitsPerBox` snapshot first; this map is only consulted when that's null.
 *
 * This header used to claim `InvoiceItem.unitsPerBox` is only ever snapshotted for a box-SPLIT
 * line — that's false, and it's the false premise that justified reading the live product
 * unconditionally. `invoices.service.ts` (~line 955) snapshots `unitsPerBox` on EVERY
 * order-derived line (`finance.prisma`'s comment on the column: "Sale-time snapshot of the
 * product's box size, carried from the order line... must use THIS value, not the live
 * product"); only a manual/freeform line (no order line) or a pre-snapshot legacy row leaves it
 * null. Reading the live product unconditionally re-interprets an old line's pack whenever the
 * product is later repacked — a line snapshotted at pack 12, product later repacked to 24,
 * silently re-books at 24 on the next delivered-basis reconcile: phantom pieces on a regulated
 * tax filing (B700), not a rare edge case.
 *
 * A product not found (deleted / bad id) is simply absent from the map — the fallback comes back
 * `undefined` for it, which `toSaleLedgerLines` treats as "no pack" (never a wrong guess).
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
 * B661/B700: the one shared `SaleLedgerLine[]` builder for all three `writeSaleEntries` callers
 * in invoices.service.ts (create's manual path, createSplitInvoices, resyncInvoiceLedger) — they
 * built byte-identical shapes off their own `items` array, so this is the actual DRY, not just a
 * line-count move.
 *
 * `packAtSale` prefers the LINE'S OWN `unitsPerBox` snapshot (frozen at order/invoice-creation
 * time, immune to a later repack) over the live product (`packMap`, from `packAtSaleByProduct`
 * above, read once per write) — never the other way around. Warns, never throws, when both exist
 * and disagree: that's evidence the product was repacked since the line was written, worth
 * knowing about even though the snapshot is still the right value to book.
 */
/**
 * SA-078(b): orderItemId -> a soon-to-be-replaced InvoiceItem's own `unitsPerBox`.
 * `invoices.service.ts`'s reconcile rebuilds (`buildInvoiceItemData`'s callers) delete
 * and recreate every InvoiceItem on a draft; a box-unaware order line has no
 * `unitsPerBox` of its own, so without this the rebuild fell through to the LIVE
 * product -- a line sold at pack 12 silently re-booked at pack 24 after a repack, on
 * every reconcile. Own function (not inline in invoices.service.ts) for the same
 * repo's-size-ratchet reason `toSaleLedgerLines` above already is.
 */
export function priorUnitsPerBoxMap(
  items: { orderItemId?: string | null; unitsPerBox?: number | null }[],
): Map<string, number | null> {
  return new Map(
    items
      .filter((it) => it.orderItemId)
      .map((it) => [it.orderItemId as string, it.unitsPerBox ?? null]),
  );
}

export function toSaleLedgerLines(items: any[], packMap: Map<string, number>) {
  return items.map((it: any) => {
    const snapshotPack: number | null = it.unitsPerBox ?? null;
    const livePack =
      it.productId && packMap.has(it.productId) ? (packMap.get(it.productId) as number) : null;
    if (snapshotPack != null && livePack != null && snapshotPack !== livePack) {
      logger.warn(
        `toSaleLedgerLines: invoiceItemId ${it.id} — snapshot unitsPerBox ${snapshotPack} ` +
          `differs from the live product's ${livePack}; using the snapshot`,
      );
    }
    return {
      invoiceItemId: it.id,
      orderItemId: it.orderItemId ?? null,
      trackedCategoryId: it.trackedCategoryId ?? null,
      trackedSubcategoryId: it.trackedSubcategoryId ?? null,
      qty: Number(it.qty),
      boxes: it.boxes ?? null,
      pieces: it.pieces ?? null,
      unitsPerBox: it.unitsPerBox ?? null,
      unitLabel: it.unitLabel ?? null,
      packAtSale: snapshotPack ?? livePack,
      netSales: finiteStoredMoney(it.subtotal, `Invoice line ${it.id} subtotal`), // SA-816c
      // SA-816: a stored non-finite levy is refused (400), never booked as a SALE row's categoryTax NaN.
      categoryTax: finiteStoredLevy(it, `Invoice line ${it.id} category tax`),
    };
  });
}
