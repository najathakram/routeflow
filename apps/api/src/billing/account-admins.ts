import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

export interface AccountAdmin {
  email: string;
  username: string | null;
}

/** Who counts as an admin account: TENANT_ADMIN, ACTIVE, not soft-deleted. The one place these three words live. */
export const ACCOUNT_ADMIN_BASE_WHERE = {
  role: "TENANT_ADMIN",
  status: "ACTIVE",
  deletedAt: null,
} satisfies Prisma.UserWhereInput;

/**
 * The ONE `where` for "an account admin we can mail" (SA-1037 r3 G4, W9): the base above plus an email on file. A reader
 * that asks "does this business have an admin to mail" (the signup journey) hands THIS object to Prisma, so the two
 * readers cannot drift. `accountAdminsOf` keeps its existing query (base + `tenantId`) and drops an empty email in its
 * `.filter`, which is the same set: its query and its result are unchanged.
 */
export const ACCOUNT_ADMIN_WHERE = {
  ...ACCOUNT_ADMIN_BASE_WHERE,
  email: { not: "" },
} satisfies Prisma.UserWhereInput;

/**
 * The ONE definition of "the account admin(s)" of a business (SA-1037 r3 G4): ACTIVE TENANT_ADMINs of the tenant,
 * not soft-deleted, oldest first (ties by id), with an email on file. Billing notifications mail every one of them; a NEW Stripe
 * customer takes the first one's address (or none). Two readers must never drift into two definitions again.
 */
export async function accountAdminsOf(
  prisma: Pick<PrismaService, "user">,
  tenantId: string,
): Promise<AccountAdmin[]> {
  const admins = await prisma.user.findMany({
    where: { tenantId, ...ACCOUNT_ADMIN_BASE_WHERE },
    select: { email: true, username: true },
    // id breaks a createdAt tie, so two admins made in the same instant always resolve to the same first one
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return admins.filter((a) => !!a.email).map((a) => ({ email: a.email, username: a.username }));
}
