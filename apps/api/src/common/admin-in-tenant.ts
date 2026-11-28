import { UserRole } from "@prisma/client";

/**
 * SA-1508 A2-ADMIN: the ONE "is this caller an admin of this tenant" predicate for the in-place edit of an issued
 * invoice (SA-1508), the order-side corrections (SA-1506), SA-1510's overpay allowance and SA-1511's filed-month mode.
 * Every ruling imports it by this name; there is exactly one definition under apps/api/src (pinned).
 *
 * True only for a TENANT_ADMIN who has a tenant context. A SUPER_ADMIN token, with or without a tenant, is NOT an
 * admin here: with no tenant `getTenantId()` is null and `forTenant()` hands back the unscoped client (SA-1105), so a
 * super admin comes in through impersonation, as the tenant admin they act as.
 */
export function isAdminInTenant(
  actor: { role?: string | null } | null | undefined,
  requestTenantId: string | null | undefined,
): boolean {
  return actor?.role === UserRole.TENANT_ADMIN && !!requestTenantId;
}
