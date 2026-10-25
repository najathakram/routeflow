import { isOverdue, overdueCutoff } from "../common/calendar-date";
import { tenantTimeZone } from "../common/tenant-time-zone";

/**
 * B330: THE licence-validity rule. A licence prints an expiry DAY (stored as that day's UTC
 * midnight, the house calendar-date convention) and stays valid through the END of that day in
 * the tenant's time zone; it is expired from the first instant of the next day there. The sale
 * guard, the buyer list, the expiry bell, the "already verified" check and the expiry sweep all
 * go through this module so they agree at every instant. It is the same day-grace rule as an
 * invoice's due date (`isOverdue` / `overdueCutoff`), DST-safe.
 */

/** True once `now` is past the end of the printed expiry day in `zone` (UTC when null). */
export function isLicenceExpired(
  expiresAt: Date | string | null | undefined,
  now: Date,
  zone: string | null | undefined,
): boolean {
  return isOverdue(expiresAt, now, zone);
}

/** The SQL twin: `expiresAt < licenceExpiryCutoff(now, zone)` selects exactly the expired rows. */
export function licenceExpiryCutoff(now: Date, zone: string | null | undefined): Date {
  return overdueCutoff(now, zone);
}

/** The current tenant's zone for a licence check, or null (UTC) when there is no tenant context. */
export function licenceZone(
  prisma: Parameters<typeof tenantTimeZone>[0],
  tenantId?: string | null,
): Promise<string | null> {
  return tenantTimeZone(prisma, { tenantId });
}
