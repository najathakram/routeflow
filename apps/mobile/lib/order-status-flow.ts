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
 * Every status can now step back exactly one stage (staff-only, reasoned — see
 * `demotionRequiresReason` below), including `DELIVERED → CONFIRMED` (the
 * "Reopen order" action — owner policy reversal 2026-08-25; this was blocked
 * as BUG-ORD-01) and `DELIVERED → PARTIALLY_DELIVERED`. The server additionally
 * 409s a DELIVERED demotion when the order was delivered on a route stop
 * that's already COMPLETED — reopen the stop from its route run instead.
 * A CANCELLED order is reopened through `POST /orders/:id/reopen` instead, which
 * is why CANCELLED has no entry here.
 */
export const ORDER_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["PENDING", "CANCELLED"],
  PENDING: ["CONFIRMED", "CANCELLED", "DRAFT"],
  CONFIRMED: ["OUT_FOR_DELIVERY", "DELIVERED", "PENDING", "CANCELLED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "PARTIALLY_DELIVERED", "CONFIRMED", "CANCELLED"],
  PARTIALLY_DELIVERED: ["OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"],
  DELIVERED: ["CONFIRMED", "PARTIALLY_DELIVERED"],
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
 *
 * `PENDING → DRAFT` and both `DELIVERED` demotions are new (2026-08-25,
 * universal one-step-back demotion): every new one-step demotion joins this
 * set, staff-only, same as the existing ones.
 */
export function demotionRequiresReason(from: string, to: string): boolean {
  return (
    (from === "CONFIRMED" && to === "PENDING") ||
    (from === "OUT_FOR_DELIVERY" && (to === "PENDING" || to === "CONFIRMED")) ||
    (from === "PARTIALLY_DELIVERED" && to === "OUT_FOR_DELIVERY") ||
    (from === "PENDING" && to === "DRAFT") ||
    (from === "DELIVERED" && (to === "CONFIRMED" || to === "PARTIALLY_DELIVERED"))
  );
}

/**
 * Whether `DELETE /orders/:id` will accept this order. As of 2026-08-25 staff
 * may delete an order in ANY status ("delete any order") — the server's only
 * remaining block is a linked invoice with recorded payments (PAID/PARTIAL),
 * which 409s with "...void the invoice first." That can't be known from the
 * order's status alone, so this always returns true and lets the screen show
 * the action unconditionally, surfacing the 409 as a toast if it comes back.
 * Kept as a named function (not inlined at call sites) so a future
 * client-visible block can slot back in here without touching the screen.
 */
export function canDeleteOrder(_status: string): boolean {
  return true;
}
