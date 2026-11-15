import { Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { operatorDeniedGroups } from "./operator-denied-groups";
import type { PermissionPrincipal } from "./operator-permissions.service";
import { mayEditPrice } from "./price-edit-answer";
import { STAFF_CAPABILITY_RULES } from "./staff-capabilities";

const logger = new Logger("PriceEdit");

/**
 * May this principal type a line price other than the system's (SA-1034, W-870)? The ONE answer every site that
 * accepts a staff-typed price uses: `staffMay(role, "EDIT_LINE_PRICE", denied)`, with the denied groups read live and
 * enforced at every site, whatever the global permissions mode (the mode is not read here). A failed deny-list read
 * throws (fails closed), as `RolesGuard` and the till guard do. When the deny list refuses an operator, one line is
 * logged (group, site, tenant; never a name or a price).
 *
 * A role that may not edit prices at all (DRIVER, CUSTOMER, SUPER_ADMIN, no principal) is `false` with no read.
 * TENANT_ADMIN passes with no read. `site` names the caller for the log only.
 *
 * Callers compute it ONCE per request, before any transaction, and pass the boolean in (the decision itself
 * still happens inside the lock against the held lines).
 */
export async function priceEditAllowedFor(
  prisma: PrismaService,
  user: PermissionPrincipal | null | undefined,
  site: string,
): Promise<boolean> {
  if (!user) return false;
  const allowed = mayEditPrice(user.role, await operatorDeniedGroups(prisma, user));
  if (!allowed && user.role === "OPERATOR") {
    logger.warn(
      `denied groups=${STAFF_CAPABILITY_RULES.EDIT_LINE_PRICE.group} handler=${site} tenant=${user.tenantId ?? "-"}`,
    );
  }
  return allowed;
}
