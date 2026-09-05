/**
 * A "calendar date" is a YYYY-MM-DD string — the meaningful part of a stored
 * UTC-midnight instant (RouteFlow's storage convention for every calendar-date
 * field: scheduledDate, expiresAt, startsAt/endsAt, issueDate, dueDate). These
 * functions are the ONLY sanctioned way to move between the two
 * representations and to find a real wall-clock day boundary — never
 * `new Date(x).getFullYear()`/`setHours` on a calendar-date field.
 */

function readCalendarParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const at = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return { year: at("year"), month: at("month"), day: at("day") };
  } catch {
    // Unknown/invalid IANA zone — fall back to UTC, never throw.
    return {
      year: instant.getUTCFullYear(),
      month: instant.getUTCMonth() + 1,
      day: instant.getUTCDate(),
    };
  }
}

function addUtcCalendarDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  // Date.UTC normalizes an out-of-range day/month itself (day 32 rolls into
  // next month) — plain calendar arithmetic, never touches a real clock.
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * The true UTC instant of 00:00:00 local wall-clock time, on the given
 * calendar day, in `timeZone`. DST-safe: reads the zone's actual UTC offset
 * AT the midnight instant itself (one Intl pass), never assumes a fixed
 * offset. Midnight is never the literal DST-transition moment in any IANA
 * zone this codebase targets (US transitions land at 2am local), so this
 * single-correction approach never lands on the transition's own
 * ambiguous/skipped hour.
 */
function localMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  let offsetMs = 0;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(guess));
    const at = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const shownAsUtc = Date.UTC(
      at("year"),
      at("month") - 1,
      at("day"),
      at("hour") === 24 ? 0 : at("hour"),
      at("minute"),
      at("second"),
    );
    offsetMs = shownAsUtc - guess;
  } catch {
    offsetMs = 0; // unknown zone — fall back to UTC, never throw
  }
  return new Date(guess - offsetMs);
}

/** UTC-midnight instant (`iso.slice(0,10)`) → its calendar-date string. `""` for null/invalid. */
export function calendarDateFromIso(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** A calendar-date string ("2026-09-03") → its UTC-midnight storage instant. */
export function isoFromCalendarDate(calendarDate: string): string {
  return `${calendarDate}T00:00:00.000Z`;
}

/**
 * [start, end) of the calendar day containing `now`, as observed in
 * `timeZone` — REAL UTC instants (not the UTC-midnight SYMBOLIC stamp
 * `calendarDateFromIso`/`isoFromCalendarDate` use for storage).
 */
export function calendarDayBounds(
  timeZone: string,
  now: Date | string = new Date(),
): { start: Date; end: Date } {
  const at = typeof now === "string" ? new Date(now) : now;
  const { year, month, day } = readCalendarParts(at, timeZone);
  const start = localMidnightUtc(year, month, day, timeZone);
  const next = addUtcCalendarDays(year, month, day, 1);
  const end = localMidnightUtc(next.year, next.month, next.day, timeZone);
  return { start, end };
}

/**
 * The calendar day (as a UTC-midnight SYMBOLIC stamp — the storage convention
 * for every calendar-date field in this schema) that `date` falls on, as
 * observed in `timeZone`. Extracted byte-for-byte from
 * invoices.service.ts's private startOfCalendarDay (pinned: T10).
 * Argument order reversed (date first) to read naturally at analytics' new
 * call sites, which pass a real value, not a config-shaped call.
 */
export function startOfCalendarDay(
  date: Date | string = new Date(),
  timeZone?: string | null,
): Date {
  const instant = typeof date === "string" ? new Date(date) : date;
  const { year, month, day } = readCalendarParts(instant, timeZone || "UTC");
  return new Date(
    `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  );
}

/**
 * The last instant (− 1 ms) of the calendar day `date` encodes, evaluated at
 * `timeZone`'s real wall-clock day boundary. `date`'s own UTC year/month/day
 * is read directly (never re-derived through `timeZone`) because every
 * calendar-date field in this schema is written as UTC midnight OF the
 * intended day. DST-safe: see `localMidnightUtc`. Falls back to UTC when
 * `timeZone` is null/undefined/invalid — this is the fallback the analytics
 * caller relies on for tenants with no `TenantConfig` row (see WP-API-CAL).
 */
export function endOfCalendarDay(date: Date | string, timeZone?: string | null): Date {
  const instant = typeof date === "string" ? new Date(date) : date;
  const next = addUtcCalendarDays(
    instant.getUTCFullYear(),
    instant.getUTCMonth() + 1,
    instant.getUTCDate(),
    1,
  );
  const nextMidnightLocal = localMidnightUtc(next.year, next.month, next.day, timeZone || "UTC");
  return new Date(nextMidnightLocal.getTime() - 1);
}
