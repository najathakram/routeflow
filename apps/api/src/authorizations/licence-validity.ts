import { isOverdue, overdueCutoff } from "../common/calendar-date";
import { tenantTimeZone } from "../common/tenant-time-zone";

/**
 * B330: THE api-side licence-validity rule. A licence prints an expiry DAY (stored as that day's UTC
 * midnight, the house calendar-date convention) and stays valid through the END of that day in the
 * tenant's time zone; it is expired from the first instant of the next day there. It is the invoice
 * due-date day-grace rule itself (`isOverdue` / `overdueCutoff`), so the two can never drift.
 *
 * The api never value-imports `@routeflow/types` (raw TS: the compiled `dist` would `require` it and
 * crash at boot, L-151), so web and mobile carry the same rule in `packages/types/licence-validity.ts`;
 * `licence-validity-callers.spec.ts` pins the two together and lists every caller.
 *
 * Zone: a null, empty or unknown IANA name falls back to UTC (`calendar-date.ts`), never to "valid
 * forever". An expiry that does not parse is expired (fail closed); no expiry at all is a permanent licence.
 */

/** The SQL twin: `expiresAt < licenceExpiryCutoff(now, zone)` selects exactly the expired rows. */
export function licenceExpiryCutoff(now: Date, zone: string | null | undefined): Date {
  return overdueCutoff(now, zone);
}

/** True once `now` is past the end of the printed expiry day in `zone` (UTC when null/unknown). */
export function isLicenceExpired(
  expiresAt: Date | string | null | undefined,
  now: Date,
  zone: string | null | undefined,
): boolean {
  if (expiresAt === null || expiresAt === undefined || expiresAt === "") return false;
  const printed = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  if (Number.isNaN(printed.getTime())) return true;
  return isOverdue(printed, now, zone);
}

/** A VERIFIED licence that has not expired: the only state that lets a regulated sale through. */
export function isLicenceLive(
  a: { status: string; expiresAt: Date | string | null | undefined },
  now: Date,
  zone: string | null | undefined,
): boolean {
  return a.status === "VERIFIED" && !isLicenceExpired(a.expiresAt, now, zone);
}

/** Lazy-expiry display status: a VERIFIED licence past its printed day reads as EXPIRED. */
export function displayLicenceStatus<S extends string>(
  a: { status: S; expiresAt: Date | string | null | undefined },
  now: Date,
  zone: string | null | undefined,
): S | "EXPIRED" {
  return a.status === "VERIFIED" && isLicenceExpired(a.expiresAt, now, zone) ? "EXPIRED" : a.status;
}

/** The tenant's zone for the licence day (null when unset; the rule above falls back to UTC). */
export function licenceZone(
  prisma: Parameters<typeof tenantTimeZone>[0],
  tenantId?: string | null,
): Promise<string | null> {
  return tenantTimeZone(prisma, { tenantId });
}
