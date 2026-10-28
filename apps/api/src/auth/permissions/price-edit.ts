import { Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { operatorDeniedGroups } from "./operator-denied-groups";
import {
  OperatorPermissionsService,
  type PermissionPrincipal,
} from "./operator-permissions.service";
import { STAFF_CAPABILITY_RULES, staffMay } from "./staff-capabilities";

const logger = new Logger("PriceEdit");

/**
 * May this principal type a line price other than the system's (SA-1034)? The ONE answer every site that
 * accepts a staff-typed price uses: `staffMay(role, "EDIT_LINE_PRICE", denied)`, with the denied groups read
 * live and the permissions MODE applied.
 *
 *   - `live`   -> the enforced answer; a failed deny-list read throws (fails closed), as `RolesGuard`.
 *   - `shadow` -> the role-only answer. When enforcement would have refused, one `would-deny` line is logged in
 *                 the RolesGuard shape (group, site, tenant; never a name or a price). A failed read allows by
 *                 the role and logs an error.
 *
 * A role that may not edit prices at all (DRIVER, CUSTOMER, SUPER_ADMIN, no principal) is `false` in both modes
 * with no read. TENANT_ADMIN passes with no read. `site` names the caller for the log only.
 *
 * Callers compute it ONCE per request, before any transaction, and pass the boolean in (the decision itself
 * still happens inside the lock against the held lines).
 */
export async function priceEditAllowedFor(
  prisma: PrismaService,
  user: PermissionPrincipal | null | undefined,
  site: string,
): Promise<boolean> {
  const roleOnly = staffMay(user?.role, "EDIT_LINE_PRICE", []);
  if (!user || !roleOnly) return false;
  const mode = new OperatorPermissionsService(prisma).mode();
  let denied: readonly string[];
  try {
    denied = await operatorDeniedGroups(prisma, user);
  } catch (err) {
    if (mode === "live") throw err; // no answer is never an allow
    logger.error(
      `price-edit lookup failed (shadow, allowed) groups=${STAFF_CAPABILITY_RULES.EDIT_LINE_PRICE.group} handler=${site} tenant=${user.tenantId ?? "-"}: ${err instanceof Error ? err.name : "error"}`,
    );
    return roleOnly;
  }
  const enforced = staffMay(user.role, "EDIT_LINE_PRICE", denied);
  if (mode === "live") return enforced;
  if (!enforced) {
    logger.warn(
      `would-deny groups=${STAFF_CAPABILITY_RULES.EDIT_LINE_PRICE.group} handler=${site} tenant=${user.tenantId ?? "-"}`,
    );
  }
  return roleOnly;
}
