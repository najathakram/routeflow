import type { Prisma } from "@prisma/client";

/**
 * W-839 / SA-937 MUST 3: is this staff user also an ACTIVE buyer of THIS tenant? True only when one CustomerLink of the
 * caller's own tenant is ACTIVE, its Customer is not deleted, and its BuyerAccount has the staff user's stored email
 * (case-insensitive: Google / Apple buyer rows may not be lowercased) and is ACTIVE, verified, not deleted and not merged.
 *
 * The tenant condition is the guard (SA-937 §3): a global "a buyer with this email exists" would let a tenant admin
 * create a staff user with any address and learn, through GET /users/me, whether it shops anywhere on RouteFlow.
 * The email always comes from the staff user's DB row, never from a request. Boolean only: no buyer id, name, customer
 * or count leaves here (MUST 4). A null-tenant user (a super admin) is false with no query.
 */
export async function hasActiveBuyerLink(
  prisma: {
    forTenant(): {
      customerLink: {
        findFirst(args: {
          where: Prisma.CustomerLinkWhereInput;
          select: { id: true };
        }): Promise<unknown>;
      };
    };
  },
  user: { email: string | null | undefined; tenantId: string | null | undefined },
): Promise<boolean> {
  if (!user.tenantId || !user.email) return false;
  const where: Prisma.CustomerLinkWhereInput = {
    tenantId: user.tenantId,
    status: "ACTIVE",
    customer: { deletedAt: null },
    buyerAccount: {
      email: { equals: user.email, mode: "insensitive" },
      status: "ACTIVE",
      emailVerified: true,
      deletedAt: null,
      mergedIntoId: null,
    },
  };
  const link = await prisma.forTenant().customerLink.findFirst({ where, select: { id: true } });
  return link != null;
}
