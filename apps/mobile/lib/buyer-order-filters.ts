/**
 * UX guide B12: the buyer Orders chips -> /buyer/orders query params. "Active" is a status GROUP the server
 * resolves from the one shared list (`ACTIVE_ORDER_STATUSES`); every other chip is one status.
 */
export const BUYER_ORDER_FILTERS = [
  { id: "ALL", label: "All" },
  { id: "ACTIVE", label: "Active" },
  { id: "PENDING", label: "Pending" },
  { id: "CONFIRMED", label: "Confirmed" },
  { id: "OUT_FOR_DELIVERY", label: "Out for delivery" },
  { id: "DELIVERED", label: "Delivered" },
  { id: "REFUSED", label: "Refused" },
  { id: "CANCELLED", label: "Cancelled" },
] as const;

export type BuyerOrderFilterId = (typeof BUYER_ORDER_FILTERS)[number]["id"];

export function buyerOrderQuery(filter: BuyerOrderFilterId): {
  status?: string;
  statusGroup?: "ACTIVE";
} {
  if (filter === "ALL") return {};
  if (filter === "ACTIVE") return { statusGroup: "ACTIVE" };
  return { status: filter };
}

/** Empty-state headline: "No orders yet" only on All; a filter names itself. */
export function buyerOrdersEmptyText(filter: BuyerOrderFilterId): string {
  if (filter === "ALL") return "No orders yet.";
  const label = BUYER_ORDER_FILTERS.find((f) => f.id === filter)?.label ?? "";
  return `No ${label.toLowerCase()} orders.`;
}
