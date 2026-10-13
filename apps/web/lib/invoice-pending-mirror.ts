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
 * The wording of the pending-mirror draft: a delivery business reviews and sends the invoice "after delivery"; a store-only
 * (POS-forced) business has no delivery at all, so the same draft is ready "after pickup". Until the capability is known
 * (`null`) neither moment is claimed. Pure, so the page and its test cannot drift.
 */
export function pendingMirrorCopy(storeOnly: boolean | null): { badge: string; note: string } {
  // `null` = the business's fulfilment capability is not known yet (loading, or a partial answer): say neither moment, so a
  // store-only business never flashes "delivery" before its capability arrives.
  if (storeOnly === null) {
    return {
      badge: "Mirrors the order \u2014 ready to send once it is handed over or delivered",
      note: "you'll review and send this invoice once it is handed over or delivered.",
    };
  }
  // owner rule: an invoice DRAFT until handed over, final at hand-over. A store-only business has no delivery: it is "pickup".
  if (storeOnly) {
    return {
      badge: "Ready to send after pickup.",
      note: "you'll review and send this invoice after pickup.",
    };
  }
  return {
    badge: "Mirrors the order \u2014 ready to send after delivery",
    note: "you'll review and send this invoice after delivery.",
  };
}
