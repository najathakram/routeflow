import type { Prisma, TenantStatus } from "@prisma/client";

/**
 * #2142 R1: a buyer account that may use the portal at all. Part of `liveBuyerLinkWhere`, and read
 * on its own by the gateway, which DISCONNECTS the sockets of an account that no longer matches.
 */
export const LIVE_BUYER_ACCOUNT_WHERE = {
  status: "ACTIVE",
  deletedAt: null,
} as const satisfies Prisma.BuyerAccountWhereInput;

/**
 * The ONE definition of "this buyer account's link opens the portal at that seller" (L-167).
 * Read per request by `BuyerSellerContextGuard` (HTTP) and per socket by `RouteFlowGateway`
 * (B104: a buyer socket's rooms), so what a buyer receives live can never drift from what the
 * portal lets the same buyer read.
 *
 * REG-B141: removing a customer leaves its link ACTIVE on purpose (a restore must bring the
 * portal back untouched), so the removal is enforced here, on every read, never by flipping the
 * link.
 *
 * #2142 R1: the same holds for the buyer's OWN account. Suspending or deleting it
 * (`BuyerAdminService.setBuyerStatus`, a merge's secondary, a self-delete) leaves every link
 * ACTIVE, so the account is checked here too: without it a suspended buyer kept its socket rooms
 * forever and its portal until the access token ran out.
 */
export function liveBuyerLinkWhere(
  buyerAccountId: string | { in: string[] },
): Prisma.CustomerLinkWhereInput {
  return {
    buyerAccountId,
    status: "ACTIVE",
    customer: { deletedAt: null },
    buyerAccount: { ...LIVE_BUYER_ACCOUNT_WHERE },
  };
}

/** Seller statuses the portal refuses outright, whatever the buyer's link says. */
export const BLOCKED_SELLER_STATUSES: readonly TenantStatus[] = ["SUSPENDED", "CANCELLED"];
