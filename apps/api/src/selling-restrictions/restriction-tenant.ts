import { ForbiddenException } from "@nestjs/common";

/**
 * The tenant a selling-restrictions check runs under, for a writer with no principal of its own
 * (an invoice / estimate service reading the ambient tenant). A tenant-less session cannot be
 * judged, so it REFUSES rather than skipping the check (fail closed) — the same rule as
 * `OrdersService.restrictionTenantId`.
 */
export function requireRestrictionTenantId(tenantId: string | null | undefined): string {
  if (tenantId) return tenantId;
  throw new ForbiddenException("Selling restrictions require a tenant-scoped session");
}
