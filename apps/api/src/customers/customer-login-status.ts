import type { UserStatus } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import { revokeUserLinkTokens } from "../common/revoke-user-link-tokens";

/**
 * Writes a customer login's `User.status`. Any write that leaves the account non-ACTIVE
 * (INACTIVE -> INACTIVE included) burns its outstanding set-password / reset links in the SAME
 * transaction; a reactivation burns nothing and restores nothing. Extracted from
 * `CustomersService.changeStatus` to keep that file under its size ratchet.
 */
export function setCustomerLoginStatus(
  prisma: Pick<PrismaService, "tenantTransaction">,
  userId: string,
  status: UserStatus,
): Promise<{ id: string; status: UserStatus }> {
  return prisma.tenantTransaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: { status },
      select: { id: true, status: true },
    });
    if (status !== "ACTIVE") await revokeUserLinkTokens(tx, userId);
    return updated;
  });
}
