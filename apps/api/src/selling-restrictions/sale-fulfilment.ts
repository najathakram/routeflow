/**
 * L8 (owner ruling 2026-10-13): WHICH state judges a STATE selling restriction is decided by HOW the goods change
 * hands, and this file is the ONE place that says so.
 *
 *  - COUNTER (an over-the-counter sale) and PICKUP (the customer collects in store) are judged on the STORE's state,
 *    for every customer, named or walk-in: the sale happens where the store is, whatever address the customer has.
 *  - DELIVERY (route / ship, and every caller that does not say) keeps the customer's address state, exactly as before.
 *
 * Pure: no I/O. `SellingRestrictionsService.evaluate` reads `judgedAtStore` and fetches the store state; the callers
 * only name the kind (`saleFulfilmentKind` from the order's own columns).
 */
export const SALE_FULFILMENT_KINDS = ["COUNTER", "PICKUP", "DELIVERY"] as const;
export type SaleFulfilmentKind = (typeof SALE_FULFILMENT_KINDS)[number];

/** The order columns that decide the kind (`Order.counterSale`, `Order.fulfillPath`). */
export interface SaleFulfilmentFacts {
  counterSale?: boolean | null;
  fulfillPath?: string | null;
}

/** COUNTER when the order is a counter sale, else PICKUP when its fulfil path is PICKUP, else DELIVERY. */
export function saleFulfilmentKind(
  facts: SaleFulfilmentFacts | null | undefined,
): SaleFulfilmentKind {
  if (facts?.counterSale === true) return "COUNTER";
  return facts?.fulfillPath === "PICKUP" ? "PICKUP" : "DELIVERY";
}

/** True only for an explicit COUNTER / PICKUP; an omitted or DELIVERY kind keeps the customer-address rule. */
export function judgedAtStore(kind: SaleFulfilmentKind | undefined): boolean {
  return kind === "COUNTER" || kind === "PICKUP";
}

/**
 * The kind of a stored order, read through the TENANT-scoped client (`prisma.forTenant()`); `undefined` for no order
 * (a manual invoice: the unchanged customer-address rule) and DELIVERY for an order that cannot be read.
 */
export async function orderFulfilmentKind(
  db: {
    order: {
      findFirst(args: {
        where: { id: string };
        select: { counterSale: true; fulfillPath: true };
      }): Promise<SaleFulfilmentFacts | null>;
    };
  },
  orderId: string | null | undefined,
): Promise<SaleFulfilmentKind | undefined> {
  if (!orderId) return undefined;
  return saleFulfilmentKind(
    await db.order.findFirst({
      where: { id: orderId },
      select: { counterSale: true, fulfillPath: true },
    }),
  );
}
