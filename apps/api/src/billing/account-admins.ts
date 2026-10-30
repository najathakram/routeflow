import type { PrismaService } from "../prisma/prisma.service";

export interface AccountAdmin {
  email: string;
  username: string | null;
}

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
    where: { tenantId, role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
    select: { email: true, username: true },
    // id breaks a createdAt tie, so two admins made in the same instant always resolve to the same first one
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return admins.filter((a) => !!a.email).map((a) => ({ email: a.email, username: a.username }));
}
