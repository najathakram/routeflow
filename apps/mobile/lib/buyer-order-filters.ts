/**
 * UX guide B12: the buyer Orders chips -> /buyer/orders query params. "Active" is a status GROUP the server
 * resolves from the one shared list (`ACTIVE_ORDER_STATUSES`); every other chip is one status.
 */
import type { OrderStatusGroupValue } from "@routeflow/types";

export const BUYER_ORDER_FILTERS = [
  { id: "ALL", label: "All", empty: "No orders yet." },
  { id: "ACTIVE", label: "Active", empty: "No active orders." },
  { id: "PENDING", label: "Pending", empty: "No pending orders." },
  { id: "CONFIRMED", label: "Confirmed", empty: "No confirmed orders." },
  { id: "OUT_FOR_DELIVERY", label: "Out for delivery", empty: "No orders out for delivery." },
  { id: "DELIVERED", label: "Delivered", empty: "No delivered orders." },
  { id: "REFUSED", label: "Refused", empty: "No refused orders." },
  { id: "CANCELLED", label: "Cancelled", empty: "No cancelled orders." },
] as const;

export type BuyerOrderFilterId = (typeof BUYER_ORDER_FILTERS)[number]["id"];

export function buyerOrderQuery(filter: BuyerOrderFilterId): {
  status?: string;
  statusGroup?: OrderStatusGroupValue;
} {
  if (filter === "ALL") return {};
  if (filter === "ACTIVE") return { statusGroup: "ACTIVE" };
  return { status: filter };
}

/**
 * B1391: the list shows the server's stored order total, never a client `qty * unitPrice` (12x on a
 * boxed line when a genuine $0 total fell through to the gross).
 */
export function buyerOrderListTotal(order: { total: number | string }): number {
  return Number(order.total);
}

/** Empty-state headline: "No orders yet" only on All; a filter names itself, as a phrase of its own. */
export function buyerOrdersEmptyText(filter: BuyerOrderFilterId): string {
  return BUYER_ORDER_FILTERS.find((f) => f.id === filter)?.empty ?? "No orders yet.";
}
