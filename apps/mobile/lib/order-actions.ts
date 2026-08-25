/**
 * Order-detail status actions (no api-client/react-query imports so they stay
 * unit-testable in the node Jest env). Extracted from
 * `(operator)/(tabs)/orders/[id].tsx`'s private `statusActions(current)` so
 * fulfillment-aware relabeling (plan §WP11) can be pinned against
 * `canTransitionOrder` (`lib/order-status-flow.ts`) without mounting the screen.
 */
import type { OrderStatus } from "./api/orders";

export interface StatusAction {
  label: string;
  toStatus: OrderStatus;
  style: "primary" | "secondary" | "warning" | "danger";
  icon: string;
  confirmMessage?: string;
  /** Passed to PATCH /status (e.g. the demote-to-CONFIRMED reason). */
  reason?: string;
  /** Route through POST /orders/:id/reopen (CANCELLED → PENDING) instead of /status. */
  reopenCancelled?: boolean;
}

/** The ROUTE-fulfillment action set — byte-identical to the pre-extraction switch. */
function routeStatusActions(current: OrderStatus): StatusAction[] {
  switch (current) {
    case "DRAFT":
      return [
        {
          label: "Submit for review",
          toStatus: "PENDING",
          style: "primary",
          icon: "arrow-forward-circle-outline",
        },
      ];
    case "PENDING":
      return [
        {
          label: "Confirm order",
          toStatus: "CONFIRMED",
          style: "primary",
          icon: "checkmark-circle-outline",
        },
        {
          label: "Cancel order",
          toStatus: "CANCELLED",
          style: "danger",
          icon: "close-circle-outline",
          confirmMessage: "Cancel this order? It cannot be undone easily.",
        },
      ];
    case "CONFIRMED":
      return [
        {
          // PR-4: this is the van-sale two-tap flow — DELIVERED already chains
          // openSendForOrder() → SendInvoiceSheet below, so promoting it to
          // primary makes "deliver, then send" the default path.
          label: "Deliver & send invoice",
          toStatus: "DELIVERED",
          style: "primary",
          icon: "flash-outline",
          confirmMessage: "Mark as delivered without going through dispatch?",
        },
        {
          label: "Send for delivery",
          toStatus: "OUT_FOR_DELIVERY",
          style: "secondary",
          icon: "car-outline",
        },
        {
          label: "Back to pending",
          toStatus: "PENDING",
          style: "warning",
          icon: "arrow-back-circle-outline",
          confirmMessage: "Revert order back to Pending?",
        },
        {
          label: "Cancel order",
          toStatus: "CANCELLED",
          style: "danger",
          icon: "close-circle-outline",
          confirmMessage: "Cancel this order?",
        },
      ];
    case "OUT_FOR_DELIVERY":
      return [
        {
          label: "Mark delivered",
          toStatus: "DELIVERED",
          style: "primary",
          icon: "checkmark-done-circle-outline",
        },
        {
          label: "Partial delivery",
          toStatus: "PARTIALLY_DELIVERED",
          style: "secondary",
          icon: "git-branch-outline",
        },
        {
          label: "Back to confirmed",
          toStatus: "CONFIRMED",
          style: "warning",
          icon: "arrow-back-circle-outline",
          confirmMessage: "Revert order back to Confirmed?",
        },
        {
          label: "Cancel order",
          toStatus: "CANCELLED",
          style: "danger",
          icon: "close-circle-outline",
          confirmMessage: "Cancel this order?",
        },
      ];
    case "PARTIALLY_DELIVERED":
      return [
        {
          label: "Mark fully delivered",
          toStatus: "DELIVERED",
          style: "primary",
          icon: "checkmark-done-circle-outline",
        },
        {
          label: "Back out for delivery",
          toStatus: "OUT_FOR_DELIVERY",
          style: "warning",
          icon: "arrow-back-circle-outline",
          confirmMessage: "Revert back to Out for delivery?",
        },
        {
          label: "Cancel order",
          toStatus: "CANCELLED",
          style: "danger",
          icon: "close-circle-outline",
          confirmMessage: "Cancel this order?",
        },
      ];
    // Note: DELIVERED has NO reopen — the API deliberately blocks
    // DELIVERED→CONFIRMED (removed as BUG-ORD-01); it would always 400. Only a
    // CANCELLED order can be reopened, via the dedicated /reopen endpoint below.
    case "CANCELLED":
      // POST /orders/:id/reopen → PENDING (OPERATOR-only; server 400s if a
      // paid/partial/written-off invoice exists).
      return [
        {
          label: "Reopen order",
          toStatus: "PENDING",
          style: "primary",
          icon: "refresh-outline",
          confirmMessage: "Reopen this cancelled order back to Pending?",
          reopenCancelled: true,
        },
      ];
    default:
      return [];
  }
}

/**
 * Available status actions for the order-detail action bar.
 *
 * `fulfillPath === "ROUTE"` (the default) is byte-identical to the
 * pre-extraction behavior. `"SHIP"` (supplier/carrier-shipped orders, never
 * routed) relabels the shipping-shaped actions IN PLACE — every action keeps
 * its original `toStatus`, so each one still passes `canTransitionOrder`
 * (`lib/order-status-flow.ts`) exactly as before — and drops "Partial
 * delivery" entirely: a dead end for a carrier shipment, since the shipment
 * either arrived or it didn't.
 */
export function statusActions(
  status: OrderStatus,
  fulfillPath: "ROUTE" | "SHIP" = "ROUTE",
): StatusAction[] {
  const actions = routeStatusActions(status);
  if (fulfillPath !== "SHIP") return actions;
  return actions
    .filter((a) => a.toStatus !== "PARTIALLY_DELIVERED")
    .map((a) => {
      if (a.toStatus === "OUT_FOR_DELIVERY") return { ...a, label: "Mark shipped" };
      if (a.toStatus === "DELIVERED") return { ...a, label: "Mark delivered" };
      if (status === "OUT_FOR_DELIVERY" && a.toStatus === "CONFIRMED") {
        return { ...a, label: "Unmark shipped" };
      }
      return a;
    });
}
