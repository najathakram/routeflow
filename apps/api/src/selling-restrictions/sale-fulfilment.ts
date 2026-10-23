/**
 * L8 (owner ruling 2026-10-13): WHICH state judges a STATE selling restriction is decided by HOW the goods change
 * hands, and this file is the ONE place that says so.
 *
 *  - COUNTER (an over-the-counter sale) and PICKUP (the customer collects in store) are judged on the STORE's state,
 *    for every customer, named or walk-in: the sale happens where the store is, whatever address the customer has.
 *  - DELIVERY (route / ship; also a record with no fulfilment of its own) keeps the customer's address state, exactly as before.
 *
 * Pure: no I/O. `SellingRestrictionsService.evaluate` reads `judgedAtStore` and fetches the store state; the callers
 * only name the kind (`saleFulfilmentKind` from the order's own columns).
 */
export const SALE_FULFILMENT_KINDS = ["COUNTER", "PICKUP", "DELIVERY"] as const;
export type SaleFulfilmentKind = (typeof SALE_FULFILMENT_KINDS)[number];

/** The order columns that decide the kind (`Order.counterSale`, `Order.fulfillPath`). */
export interface SaleFulfilmentFacts {
  counterSale: boolean | null | undefined;
  fulfillPath: string | null | undefined;
}

/** COUNTER when the order is a counter sale, else PICKUP when its fulfil path is PICKUP, else DELIVERY. */
export function saleFulfilmentKind(
  facts: SaleFulfilmentFacts | null | undefined,
): SaleFulfilmentKind {
  if (facts?.counterSale === true) return "COUNTER";
  return facts?.fulfillPath === "PICKUP" ? "PICKUP" : "DELIVERY";
}

/** True only for COUNTER / PICKUP; a DELIVERY kind keeps the customer-address rule. */
export function judgedAtStore(kind: SaleFulfilmentKind): boolean {
  return kind === "COUNTER" || kind === "PICKUP";
}

/**
 * The kind of a stored order, read through the TENANT-scoped client (`prisma.forTenant()`); `undefined` for no order
 * DELIVERY for no order (a manual invoice: the customer-address rule) and for an order that cannot be read.
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
): Promise<SaleFulfilmentKind> {
  if (!orderId) return "DELIVERY"; // a manual invoice has no fulfilment of its own
  return saleFulfilmentKind(
    await db.order.findFirst({
      where: { id: orderId },
      select: { counterSale: true, fulfillPath: true },
    }),
  );
}
