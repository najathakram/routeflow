import type { Prisma, TenantStatus } from "@prisma/client";

/**
 * The ONE definition of "this buyer account's link opens the portal at that seller" (L-167).
 * Read per request by `BuyerSellerContextGuard` (HTTP) and per socket by `RouteFlowGateway`
 * (B104: a buyer socket's rooms), so what a buyer receives live can never drift from what the
 * portal lets the same buyer read.
 *
 * REG-B141: removing a customer leaves its link ACTIVE on purpose (a restore must bring the
 * portal back untouched), so the removal is enforced here, on every read, never by flipping the
 * link.
 */
export function liveBuyerLinkWhere(
  buyerAccountId: string | { in: string[] },
): Prisma.CustomerLinkWhereInput {
  return { buyerAccountId, status: "ACTIVE", customer: { deletedAt: null } };
}

/** Seller statuses the portal refuses outright, whatever the buyer's link says. */
export const BLOCKED_SELLER_STATUSES: readonly TenantStatus[] = ["SUSPENDED", "CANCELLED"];
