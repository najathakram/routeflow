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
