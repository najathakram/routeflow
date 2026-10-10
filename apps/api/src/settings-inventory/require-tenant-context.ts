import { ForbiddenException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * The ambient tenant, or a coded 403. A caller with NO tenant context (a SUPER_ADMIN who is not
 * impersonating, a job) must be refused: `forTenant()` returns the UNSCOPED client then, so a
 * read or write would cross tenants. Call it BEFORE any read or write.
 */
export function requireTenantContext(prisma: Pick<PrismaService, "getTenantId">): string {
  const tenantId = prisma.getTenantId();
  if (!tenantId) {
    throw new ForbiddenException({
      statusCode: 403,
      code: API_ERROR_CODES.TENANT_CONTEXT_REQUIRED,
      message: "This setting is per tenant: there is no tenant context on this request.",
    });
  }
  return tenantId;
}
