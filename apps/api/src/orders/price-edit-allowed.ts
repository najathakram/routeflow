import { staffMay } from "../auth/permissions/staff-capabilities";
import type { PermissionPrincipal } from "../auth/permissions/operator-permissions.service";
import type { PrismaService } from "../prisma/prisma.service";
import { operatorDeniedGroups } from "./counter-sale/till-permission.guard";

/**
 * W-870: may this caller change a line's price? The caller's own decision when it made one (the counter sale), else the
 * role's `EDIT_LINE_PRICE` over the OPERATOR's live denied groups. Read once, before any transaction or lock; nobody but
 * an OPERATOR costs a read, and no principal means no capability.
 */
export async function mayEditPrice(
  prisma: PrismaService,
  user: PermissionPrincipal | undefined,
  own?: boolean,
): Promise<boolean> {
  if (own !== undefined) return own;
  return staffMay(
    user?.role,
    "EDIT_LINE_PRICE",
    user ? await operatorDeniedGroups(prisma, user) : [],
  );
}
