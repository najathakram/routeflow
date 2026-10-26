import { tenantTimeZone } from "../common/tenant-time-zone";

/**
 * B330: THE licence-validity rule lives in `@routeflow/types` (`licence-validity.ts`) so the api, the web
 * dashboard and the mobile app agree at every instant; this module re-exports it for the api and adds the
 * tenant-zone read. The sale guard, the buyer list, the expiry bell, the "already verified" check, the expiry
 * sweep, the buyer regulated-visibility gate and the customer-merge rank all go through it.
 */
export {
  displayLicenceStatus,
  isLicenceExpired,
  isLicenceLive,
  licenceExpiryCutoff,
} from "@routeflow/types";

/** The current tenant's zone for a licence check, or null (UTC) when there is no tenant context. */
export function licenceZone(
  prisma: Parameters<typeof tenantTimeZone>[0],
  tenantId?: string | null,
): Promise<string | null> {
  return tenantTimeZone(prisma, { tenantId });
}
