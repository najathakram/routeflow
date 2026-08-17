/**
 * Pure order status-flow helpers (no api-client/react-query imports so they stay
 * unit-testable in the node Jest env). Mirror the server's guards in
 * `orders.service.ts` `changeStatus`/`deleteOrder` so a visible control never
 * earns a guaranteed 400.
 */

/**
 * The server's transition table (`orders.service.ts` changeStatus). Anything not
 * listed 400s with "Cannot transition from X to Y" BEFORE any other check runs.
 *
 * `DELIVERED` is deliberately terminal: there is no demote-out-of-delivered.
 * A CANCELLED order is reopened through `POST /orders/:id/reopen` instead, which
 * is why CANCELLED has no entry here.
 */
export const ORDER_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["PENDING", "CANCELLED"],
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["OUT_FOR_DELIVERY", "DELIVERED", "PENDING", "CANCELLED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "PARTIALLY_DELIVERED", "CONFIRMED", "CANCELLED"],
  PARTIALLY_DELIVERED: ["OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"],
  DELIVERED: [],
};

/** Whether `PATCH /orders/:id/status` will accept this move at all. */
export function canTransitionOrder(from: string, to: string): boolean {
  return (ORDER_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Whether the server demands a `reason` for this move — it 400s with "A reason is
 * required when demoting an order" otherwise.
 *
 * A literal mirror of the server's `isDemotion`, including
 * `OUT_FOR_DELIVERY → PENDING`, which the transition table above rejects first
 * (so that arm is unreachable today). Kept faithful rather than pruned: if the
 * table ever gains the move, this stays correct. Callers must still gate on
 * `canTransitionOrder` — a reason does not make an illegal move legal.
 */
export function demotionRequiresReason(from: string, to: string): boolean {
  return (
    (from === "CONFIRMED" && to === "PENDING") ||
    (from === "OUT_FOR_DELIVERY" && (to === "PENDING" || to === "CONFIRMED")) ||
    (from === "PARTIALLY_DELIVERED" && to === "OUT_FOR_DELIVERY")
  );
}

/**
 * Whether `DELETE /orders/:id` will accept this order. The server allows only
 * DRAFT/PENDING/CANCELLED and 400s with "Only DRAFT, PENDING, or CANCELLED
 * orders can be deleted" for everything else — which covers the four statuses a
 * live order spends most of its life in.
 */
export function canDeleteOrder(status: string): boolean {
  return status === "DRAFT" || status === "PENDING" || status === "CANCELLED";
}
