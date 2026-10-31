/**
 * The order-linked DRAFT that mirrors an un-delivered order: it auto-syncs to the order and the API
 * refuses to edit or send it until the order is delivered (assertOrderInvoiceUnlocked). Shared by the
 * invoice detail page (hides Edit) and the edit route (redirects to the order) so they cannot drift (#2791).
 */
export function isPendingMirrorInvoice(inv: {
  /** The server's own answer (it knows the tenant's fulfilment mode; clients cannot). Wins when present. */
  pendingMirror?: boolean | null;
  orderId?: string | null;
  status?: string | null;
  deliveryBatchId?: string | null;
  order?: { status?: string | null } | null;
}): boolean {
  if (typeof inv.pendingMirror === "boolean") return inv.pendingMirror;
  return (
    !!inv.orderId &&
    inv.status === "DRAFT" &&
    !inv.deliveryBatchId &&
    !!inv.order &&
    inv.order.status !== "DELIVERED" &&
    inv.order.status !== "PARTIALLY_DELIVERED"
  );
}

/**
 * The note under the pending-mirror header: a delivery order is reviewed and sent "after delivery"; a pickup order (or a
 * store-only, POS-forced business) has no delivery at all, so the same draft is ready "after pickup". Until the moment is
 * known (`null`) neither is claimed. Pure, so the page and its test cannot drift. The reason beside the locked Send is
 * `sendsAfterLabel`, the same value; there is no separate pill (SA-1066 M4).
 */
export function pendingMirrorCopy(storeOnly: boolean | null): { note: string } {
  // `null` = neither the order's path nor the business's fulfilment capability is known yet (loading, or a partial answer):
  // say neither moment, so a pickup order never flashes "delivery" before its capability arrives.
  if (storeOnly === null) {
    return { note: "you'll review and send this invoice once it is handed over or delivered." };
  }
  // owner rule: an invoice DRAFT until handed over, final at hand-over. A pickup order has no delivery.
  if (storeOnly) return { note: "you'll review and send this invoice after pickup." };
  return { note: "you'll review and send this invoice after delivery." };
}
