import type { SaleAxisLine } from "@routeflow/pricing";

/**
 * SA-789 F1 (row 558): the ONE place a regulated ledger row's `invoiceItemId` is turned back into a
 * line. The ledger is append-only and keeps the id the line had when the row was written; a legacy
 * single-draft rebuild deletes and re-creates every InvoiceItem under a fresh id, so that id can point
 * at nothing while the row's `orderItemId` is stable. Every reader resolves the invoice item FIRST and
 * the order item SECOND, and none of them may map `invoiceItemId` to an item on its own (pinned by
 * `sale-line-resolver.sa789.spec.ts`).
 */

/** A ledger row as the resolver needs it. */
export interface SaleLineRef {
  id: string;
  invoiceItemId: string | null;
  orderItemId: string | null;
}

export interface ResolvedSaleLine {
  /** Stored box/piece shape of the resolved line (null when neither source resolves). */
  line: SaleAxisLine | null;
  productId: string | null;
  /** The line's own qty (its own unit); null when unresolved. */
  qty: number | null;
  /** The invoice item the row points at, ONLY when it still exists; null when it rotated away. */
  liveInvoiceItemId: string | null;
  /** True when the line came from the order item because the invoice item is gone. */
  viaOrderItem: boolean;
}

const LINE_SELECT = {
  id: true,
  qty: true,
  boxes: true,
  pieces: true,
  unitLabel: true,
  unitsPerBox: true,
  productId: true,
} as const;

export async function resolveSaleLines(
  db: any,
  sales: SaleLineRef[],
): Promise<Map<string, ResolvedSaleLine>> {
  const invoiceItemIds = [
    ...new Set(sales.map((s) => s.invoiceItemId).filter(Boolean)),
  ] as string[];
  const orderItemIds = [...new Set(sales.map((s) => s.orderItemId).filter(Boolean))] as string[];
  const [invoiceItems, orderItems] = await Promise.all([
    invoiceItemIds.length > 0
      ? db.invoiceItem.findMany({ where: { id: { in: invoiceItemIds } }, select: LINE_SELECT })
      : [],
    orderItemIds.length > 0
      ? db.orderItem.findMany({ where: { id: { in: orderItemIds } }, select: LINE_SELECT })
      : [],
  ]);
  const byInvoiceItem = new Map<string, any>(invoiceItems.map((i: any) => [i.id, i]));
  const byOrderItem = new Map<string, any>(orderItems.map((i: any) => [i.id, i]));
  const out = new Map<string, ResolvedSaleLine>();
  for (const s of sales) {
    const live = s.invoiceItemId ? byInvoiceItem.get(s.invoiceItemId) : undefined;
    const viaOrder = live ? undefined : s.orderItemId ? byOrderItem.get(s.orderItemId) : undefined;
    const shape = live ?? viaOrder ?? null;
    out.set(s.id, {
      line: shape
        ? {
            boxes: shape.boxes,
            pieces: shape.pieces,
            unitLabel: shape.unitLabel,
            unitsPerBox: shape.unitsPerBox,
          }
        : null,
      productId: shape?.productId ?? null,
      qty: shape && shape.qty != null ? Number(shape.qty) : null,
      liveInvoiceItemId: live ? live.id : null,
      viaOrderItem: !live && !!viaOrder,
    });
  }
  return out;
}
