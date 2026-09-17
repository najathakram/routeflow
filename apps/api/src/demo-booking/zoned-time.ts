/**
 * Wall-clock ↔ instant conversion for a single IANA time zone.
 *
 * The API has no date library (`date-fns` is web-only), and the house pattern
 * for zone-aware date work is `Intl.DateTimeFormat.formatToParts` — see
 * `common/calendar-date.ts`, whose conventions these helpers follow. Demo
 * booking needs something `calendar-date.ts` deliberately does not do: turn a
 * *wall-clock time* ("09:00 in America/Chicago on 2026-10-14") into the UTC
 * instant it names, so availability can be generated from business hours.
 */

/** Milliseconds `timeZone` is ahead of UTC at `instant` (negative west of UTC). */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const at = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asIfUtc = Date.UTC(
      at("year"),
      at("month") - 1,
      at("day"),
      at("hour"),
      at("minute"),
      at("second"),
    );
    // `asIfUtc` reads the zone's wall clock as though it were UTC, so the
    // difference from the real instant IS the offset.
    return asIfUtc - instant.getTime();
  } catch {
    // Unknown/invalid IANA zone — treat as UTC, never throw. Mirrors the
    // fallback in common/calendar-date.ts.
    return 0;
  }
}

/**
 * The UTC instant at which `timeZone`'s wall clock reads the given date/time.
 *
 * Offsets are resolved twice because the first guess is evaluated at the wrong
 * instant across a DST boundary: a naive single pass puts 02:30 on a spring-
 * forward morning an hour out. The second pass re-reads the offset at the
 * corrected instant and wins when they disagree.
 *
 * Wall-clock times that do not exist (inside a spring-forward gap) resolve
 * backwards to the pre-jump offset — 02:30 on a US spring-forward morning
 * lands on 01:30 local — and times that occur twice (a fall-back overlap)
 * resolve to the first. Neither matters for business-hours slots, which never
 * sit in the small hours, but both are defined rather than accidental.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstPass = asIfUtc - zoneOffsetMs(new Date(asIfUtc), timeZone);
  const secondOffset = zoneOffsetMs(new Date(firstPass), timeZone);
  const secondPass = asIfUtc - secondOffset;
  return new Date(secondPass);
}

/** The `{year, month, day}` and weekday `timeZone`'s clock shows at `instant`. */
export function zonedDateParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; weekday: number } {
  const shifted = new Date(instant.getTime() + zoneOffsetMs(instant, timeZone));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(), // 0 = Sunday
  };
}

/** `YYYY-MM-DD` as `timeZone` sees `instant`. */
export function zonedDateKey(instant: Date, timeZone: string): string {
  const { year, month, day } = zonedDateParts(instant, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** True when `timeZone` is a zone this runtime's ICU actually knows. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
