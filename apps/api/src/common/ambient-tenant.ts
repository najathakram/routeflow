import { InternalServerErrorException, Logger } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * Refuses to act for a tenant other than the ambient one. `forTenant()` spreads the ambient
 * tenant over any explicit `tenantId` in a `where`, so without this an explicit id that disagrees
 * with the request context would silently read another tenant's rows. No ambient tenant (cron /
 * system paths, L-124) is fine — those callers rely on the explicit `tenantId` they pass.
 */
export function assertAmbientTenant(
  prisma: Pick<PrismaService, "getTenantId">,
  tenantId: string,
  caller: string,
): void {
  const ambient = prisma.getTenantId();
  if (ambient && ambient !== tenantId) {
    new Logger("AmbientTenant").error(`${caller}: tenantId does not match the ambient tenant`);
    throw new InternalServerErrorException(); // generic to the client; the detail is logged
  }
}
