/**
 * B330: THE licence-validity rule, shared by api, web and mobile (no mirrors). A licence prints an
 * expiry DAY (stored as that day's UTC midnight, the house calendar-date convention) and stays valid
 * through the END of that day in the tenant's time zone; it is expired from the first instant of the
 * next day there. Same day-grace rule as an invoice's due date, DST-safe: the zone's calendar day of
 * `now` is read with Intl, never by adding 24 hours to a local midnight.
 *
 * Every place that asks "is this licence still good?" goes through this module: the sale guard, the buyer
 * list and bells, the "already verified" check, the expiry sweep, the buyer regulated-visibility gate, the
 * customer-merge rank and the web/mobile status badge. `licence-validity-callers.spec.ts` (api) lists them
 * and fails the build on a new caller that compares `expiresAt` to the clock inline.
 *
 * Zone: a null, empty or unknown IANA name falls back to UTC (the house rule of `calendar-date.ts`), never
 * to "valid forever". An expiry that does not parse is expired (fail closed); no expiry at all is a
 * permanent licence.
 */

/** The zone to read the day in: `zone` when Intl knows it, else UTC. */
function licenceZoneOrUtc(zone: string | null | undefined): string {
  if (typeof zone !== "string" || zone.length === 0) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

/** `instant`'s calendar day in `zone`, as that day's UTC-midnight stamp (ms). */
function dayStampInZone(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const at = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(at("year"), at("month") - 1, at("day"));
}

/** The SQL twin: `expiresAt < licenceExpiryCutoff(now, zone)` selects exactly the expired rows. */
export function licenceExpiryCutoff(now: Date, zone: string | null | undefined): Date {
  return new Date(dayStampInZone(now, licenceZoneOrUtc(zone)));
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
  const printedDay = Date.UTC(
    printed.getUTCFullYear(),
    printed.getUTCMonth(),
    printed.getUTCDate(),
  );
  return printedDay < licenceExpiryCutoff(now, zone).getTime();
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
