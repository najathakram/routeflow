import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

export interface AccountAdmin {
  email: string;
  username: string | null;
}

/**
 * The ONE `where` for "an account admin we can mail" (SA-1037 r3 G4, W9, SA-1165 A1): TENANT_ADMIN, ACTIVE, not
 * soft-deleted, with an email on file. Every reader hands THIS object to Prisma (`accountAdminsOf` below, and the
 * signup journey's "does this business have an admin to mail"), so the readers cannot drift into two definitions.
 * It is the only admin where this file exports.
 */
export const ACCOUNT_ADMIN_WHERE = {
  role: "TENANT_ADMIN",
  status: "ACTIVE",
  deletedAt: null,
  email: { not: "" },
} satisfies Prisma.UserWhereInput;

/**
 * The ONE definition of "the account admin(s)" of a business (SA-1037 r3 G4): `ACCOUNT_ADMIN_WHERE` for the tenant,
 * oldest first (ties by id). Billing notifications mail every one of them; a NEW Stripe customer takes the first
 * one's address (or none). Two readers must never drift into two definitions again.
 */
export async function accountAdminsOf(
  prisma: Pick<PrismaService, "user">,
  tenantId: string,
): Promise<AccountAdmin[]> {
  const admins = await prisma.user.findMany({
    where: { tenantId, ...ACCOUNT_ADMIN_WHERE },
    select: { email: true, username: true },
    // id breaks a createdAt tie, so two admins made in the same instant always resolve to the same first one
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return admins.map((a) => ({ email: a.email, username: a.username }));
}
