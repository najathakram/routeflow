/**
 * Pure helpers for the buyer order-tracking card + Reorder action (P10-BUY-8).
 * No network, no price math — Reorder carries qty/box/piece counts forward
 * UNCHANGED; the server (POST /buyer/orders) re-prices and re-runs every
 * guard fresh, same as any other buyer order create.
 */
import type { BuyerOrder } from "./api/buyer";

export interface ReorderItem {
  productId: string;
  qty: number;
  boxes?: number;
  pieces?: number;
}

/** Non-cancelled, catalog-backed (productId present), positive-qty lines
 *  only. Operator-added "unlisted" lines (no productId) can exist on an
 *  order but can never be reordered through the buyer create path. */
export function buildReorderItems(order: Pick<BuyerOrder, "lineItems">): ReorderItem[] {
  return order.lineItems
    .filter((li) => li.status !== "CANCELLED" && !!li.productId && Number(li.qty) > 0)
    .map((li) => ({
      productId: li.productId,
      qty: Number(li.qty),
      ...(li.boxes != null ? { boxes: li.boxes } : {}),
      ...(li.pieces != null ? { pieces: li.pieces } : {}),
    }));
}

/** Reorder only makes sense once an order has actually been placed — DRAFT/
 *  PENDING orders are still directly editable (see the existing Edit-items
 *  action), so Reorder is hidden there to avoid two competing affordances. */
export function canReorder(order: Pick<BuyerOrder, "status">): boolean {
  return order.status !== "DRAFT" && order.status !== "PENDING";
}

/** Timeline step index for the 5-step bar (mirrors web's buyer-order-detail
 *  STATUS_STEPS). -1 for any status not in the happy path (e.g. CANCELLED —
 *  callers hide the whole tracking section for CANCELLED instead). */
const STATUS_STEPS = [
  "PENDING",
  "CONFIRMED",
  "OUT_FOR_DELIVERY",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
];
export function trackingStepIndex(status: string): number {
  return STATUS_STEPS.indexOf(status);
}

/** F11 (B146). Buyer-card headline for the live tracking block. Precedence is
 *  deliberate: a cancelled run outranks everything (defensive — the server
 *  returns tracking: null for CANCELLED since F11, but a new app against an
 *  old server or a stale cache must never read "You're next"); a SKIPPED own
 *  stop outranks the live-run copy regardless of runStatus (a pre-fix SKIPPED
 *  stop on a COMPLETED run reads the same); stopsAhead is ignored when skipped
 *  (it structurally excludes the own stop, so it would say 0 → "You're next"). */
export function trackingHeadline(t: {
  runStatus: string;
  stopStatus: string;
  stopsAhead: number;
}): string | null {
  if (t.runStatus === "CANCELLED") {
    return "This delivery run was cancelled — your order will be rescheduled.";
  }
  if (t.stopStatus === "SKIPPED") {
    return "Your stop was skipped on this run — the seller will follow up to reschedule.";
  }
  if (t.runStatus === "IN_PROGRESS") {
    return t.stopsAhead === 0
      ? "You're next on the route"
      : `${t.stopsAhead} stop${t.stopsAhead === 1 ? "" : "s"} ahead of you`;
  }
  return null;
}

/** F11 (B146). Poll cadence for useBuyerOrderTracking. Today's rule (order is
 *  OUT_FOR_DELIVERY / PARTIALLY_DELIVERED) PLUS "the run is IN_PROGRESS" — a
 *  CONFIRMED order on a live run never refreshed, so it could never observe
 *  its own skip. A terminal order (DELIVERED / CANCELLED) stops polling even
 *  while its run is still live: neither the release helper nor completeStop
 *  clears a terminal order's stop pointer, so its tracking payload keeps
 *  reporting the run's status for the rest of the trip — without this arm a
 *  buyer delivered at stop 2 of 10 would poll for hours. `false` pauses the
 *  poll (TanStack v5 function form). */
export function trackingRefetchInterval(
  data: { status: string; tracking: { runStatus: string } | null } | undefined,
): number | false {
  if (!data) return false;
  if (data.status === "OUT_FOR_DELIVERY" || data.status === "PARTIALLY_DELIVERED") return 20_000;
  if (data.status === "DELIVERED" || data.status === "CANCELLED") return false;
  if (data.tracking?.runStatus === "IN_PROGRESS") return 20_000;
  return false;
}
