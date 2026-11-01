import type { BadgeStatus } from "@routeflow/ui/web";

/**
 * Displayed fulfillment status for an order line. `OrderItem.status` only advances to
 * DELIVERED/PARTIAL via the route delivery flow (completeStop); when an order is marked
 * delivered another way (operator status change, van sale, `/routes` stop-complete) the
 * lines stay at their PENDING default. Derive the shown label from real delivery data
 * (deliveredQty) or the order's terminal state so the page reads consistently — WITHOUT
 * mutating the stored item status (item status stays route-authoritative).
 *
 * A pickup order has no route, so a line still at its default on an open one has nothing to say: the order header
 * already gives the state, and an amber "Pending" per line only reads as a problem (SA-1066 F15). It returns null there
 * (no badge). Real outcomes (cancelled, delivered, partial) still show, and every delivery order is unchanged.
 */
export function displayLineStatus(
  li: { status: string; deliveredQty?: number; qty: number },
  orderStatus: string,
  fulfillPath?: string | null,
): BadgeStatus | null {
  // A real line-level outcome (route-recorded or explicitly set) always wins.
  if (li.status === "CANCELLED" || li.status === "DELIVERED" || li.status === "PARTIAL")
    return li.status as BadgeStatus;
  // Line still at its PENDING/CONFIRMED default:
  const delivered = Number(li.deliveredQty ?? 0);
  if (delivered > 0) return delivered + 1e-6 >= Number(li.qty) ? "DELIVERED" : "PARTIAL";
  // No per-line delivery recorded, but the whole order is delivered → reflect that.
  if (orderStatus === "DELIVERED") return "DELIVERED";
  if (fulfillPath === "PICKUP" && orderStatus !== "CANCELLED") return null;
  return li.status as BadgeStatus;
}
