import { BadRequestException } from "@nestjs/common";

/**
 * `OrdersService.changeStatus`'s transition table and demotion-reason rule, lifted VERBATIM out of the
 * method (SA-065 size-ratchet slice for #2391; behaviour-neutral). Pure: no DB, no `this`.
 *
 * Owner reversed policy 2026-08-25: EVERY state may step back one stage, so
 * `PENDING → DRAFT` and `DELIVERED → CONFIRMED` (the "Reopen Order" action,
 * previously removed as BUG-ORD-01) / `DELIVERED → PARTIALLY_DELIVERED`
 * ("it wasn't fully delivered after all") are legal. The service's role gates
 * already make them staff-only — CUSTOMER may only cancel, DRIVER may only
 * confirm. Mirrored EXACTLY by `apps/mobile/lib/order-status-flow.ts`.
 */
export const ORDER_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["PENDING", "CANCELLED"],
  PENDING: ["CONFIRMED", "CANCELLED", "DRAFT"],
  CONFIRMED: ["OUT_FOR_DELIVERY", "DELIVERED", "PENDING", "CANCELLED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "PARTIALLY_DELIVERED", "CONFIRMED", "CANCELLED"],
  PARTIALLY_DELIVERED: ["OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"],
  DELIVERED: ["CONFIRMED", "PARTIALLY_DELIVERED"],
};

/**
 * Throws the service's own 400s for an illegal transition, and for a demotion with no reason.
 * Returns `isDeliveredDemotion` (DELIVERED → CONFIRMED / PARTIALLY_DELIVERED), which the caller's
 * status write uses to clear `deliveredAt`.
 */
export function assertOrderStatusTransition(
  from: string,
  to: string,
  reason: string | null | undefined,
): { isDeliveredDemotion: boolean } {
  if (!(ORDER_STATUS_TRANSITIONS[from] ?? []).includes(to)) {
    throw new BadRequestException(`Cannot transition from ${from} to ${to}`);
  }
  // Demotions require a reason
  const isDeliveredDemotion =
    from === "DELIVERED" && (to === "CONFIRMED" || to === "PARTIALLY_DELIVERED");
  const isDemotion =
    (from === "CONFIRMED" && to === "PENDING") ||
    (from === "OUT_FOR_DELIVERY" && (to === "PENDING" || to === "CONFIRMED")) ||
    (from === "PARTIALLY_DELIVERED" && to === "OUT_FOR_DELIVERY") ||
    (from === "PENDING" && to === "DRAFT") ||
    isDeliveredDemotion;
  if (isDemotion && !reason?.trim()) {
    throw new BadRequestException("A reason is required when demoting an order");
  }
  return { isDeliveredDemotion };
}
