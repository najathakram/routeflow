import { isPostDeliveryOrderStatus } from "@routeflow/types";
import { roundMoney } from "@routeflow/pricing";

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
    // SA-1101: a REFUSED order is post-delivery too, so its $0 draft is not a pending mirror
    !isPostDeliveryOrderStatus(inv.order.status) &&
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

/**
 * UX guide B6: a DRAFT stays DRAFT after a prepayment (`statusFromPayments` keeps it terminal, by design), so say
 * what the money did. "full" = DRAFT, total > 0 and nothing left to pay; "part" = DRAFT with some paid and some due;
 * otherwise "none". A missing `balanceDue` claims nothing. One predicate for every page that shows the chip.
 */
export function paidInAdvance(inv: {
  status?: string | null;
  total?: number | string | null;
  balanceDue?: number | string | null;
}): "full" | "part" | "none" {
  if (inv.status !== "DRAFT" || inv.balanceDue == null || inv.total == null) return "none";
  const total = Number(inv.total);
  const balanceDue = Number(inv.balanceDue);
  if (!Number.isFinite(total) || !Number.isFinite(balanceDue)) return "none";
  if (total > 0.001 && balanceDue <= 0.001) return "full";
  if (balanceDue > 0.001 && roundMoney(total - balanceDue) > 0.001) return "part";
  return "none";
}
