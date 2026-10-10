import type { MutationType, Prisma } from "@prisma/client";

/**
 * B785/SA-131a: a DeliveryMutation row is genuine delivery evidence — proof that a delivery
 * attempt actually happened for an order at a stop — only when it carries a real delivered/
 * refused quantity for THIS attempt. Two shapes must never count:
 * - ADD_ON: an at-stop change-request addition, not evidence the order's own delivery was
 *   ever resolved.
 * - a REFUSED (or any) row with `quantityDelivered: null`: the order was removed from the
 *   stop via change request, never actually attempted at the door — as opposed to a REFUSED
 *   row with `quantityDelivered: 0`, a real refusal, which DOES count.
 *
 * The shared source: #1274's own `isEvidenceRow` moves onto these constants in Lane F's B785
 * follow-up — this file is not touched by that migration, only consumed by it. Finalized here
 * (readonly, `satisfies`-checked against Prisma's own input types) since Lane F copies it
 * byte-identically.
 */
export const DELIVERY_EVIDENCE_TYPES = [
  "DELIVERED",
  "PARTIAL",
  "SUBSTITUTED",
  "REFUSED",
] as const satisfies readonly MutationType[];

export const DELIVERY_EVIDENCE_WHERE = {
  quantityDelivered: { not: null },
  // Prisma's generated `in` filter wants a mutable array — spread the readonly
  // DELIVERY_EVIDENCE_TYPES into a fresh one rather than loosen its own type.
  type: { in: [...DELIVERY_EVIDENCE_TYPES] },
} satisfies Prisma.DeliveryMutationWhereInput;
