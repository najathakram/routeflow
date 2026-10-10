import { ForbiddenException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * WS4 (#2872 review): `prisma.forTenant()` returns the UNSCOPED client when there is no tenant
 * context (a SUPER_ADMIN without an impersonated tenant, a job, lost CLS), so an unscoped
 * `findFirst({ key })` would read or OVERWRITE another tenant's row. The delivery log, the health
 * strip and the staff-email settings therefore refuse outright with a coded 403.
 */
export function requireTenantContext(prisma: Pick<PrismaService, "getTenantId">): string {
  const tenantId = prisma.getTenantId();
  if (!tenantId) {
    throw new ForbiddenException({
      code: API_ERROR_CODES.TENANT_CONTEXT_REQUIRED,
      message: "This action needs a tenant context.",
    });
  }
  return tenantId;
}
