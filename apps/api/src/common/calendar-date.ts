import { BadRequestException } from "@nestjs/common";

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

/** The zone's UTC offset (ms) at `instantMs`; 0 for an unknown zone, never throws. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
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
    }).formatToParts(new Date(instantMs));
    const at = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const shownAsUtc = Date.UTC(
      at("year"),
      at("month") - 1,
      at("day"),
      at("hour") === 24 ? 0 : at("hour"),
      at("minute"),
      at("second"),
    );
    return shownAsUtc - instantMs;
  } catch {
    return 0; // unknown zone — fall back to UTC, never throw
  }
}

/**
 * The true UTC instant at which the given calendar day STARTS in `timeZone` (SA-985): two candidates, the offset
 * taken at 00:00Z and the offset re-taken at that first candidate; of those, the ones whose local date IS the named
 * day, the earliest. A single pass stores the previous day on an east-of-UTC DST-change day (the 00:00Z offset is
 * the other side of the change); a plain second pass loses the days whose local midnight does not exist (a zone
 * that springs forward AT 00:00 starts the day at 01:00). When neither candidate lands on the day it returns the
 * first (the pre-SA-985 answer).
 */
function localMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const first = guess - zoneOffsetMs(guess, timeZone);
  const second = guess - zoneOffsetMs(first, timeZone);
  const onDay = [first, second]
    .filter((t) => {
      const c = readCalendarParts(new Date(t), timeZone);
      return c.year === year && c.month === month && c.day === day;
    })
    .sort((x, y) => x - y);
  return new Date(onDay[0] ?? first);
}

const CALENDAR_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Strict "YYYY-MM-DD" → its parts, or null when the string is malformed OR names a day that
 * does not exist (2026-02-30) — `new Date()` would silently roll such a day into the next month.
 */
export function parseCalendarDay(
  value: string,
): { year: number; month: number; day: number } | null {
  const m = CALENDAR_DAY_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/**
 * The REAL UTC instant at which calendar day `day` ("YYYY-MM-DD") begins in `timeZone` — the
 * lower bound (inclusive) of that day for a real-instant column (`CreditNote.createdAt`,
 * `Return.refundedAt`); the next day's value is the exclusive upper bound. The inverse of
 * `startOfCalendarDay` at a day's edges, DST-safe (see `localMidnightUtc`). A null/blank/
 * unknown zone falls back to UTC, same as every helper here. Throws RangeError on a value that
 * is not a real calendar day — callers validate input first; this is the last line.
 */
export function startOfLocalDay(day: string, timeZone?: string | null): Date {
  const parts = parseCalendarDay(day);
  if (!parts) throw new RangeError(`startOfLocalDay: not a calendar day: ${JSON.stringify(day)}`);
  return localMidnightUtc(parts.year, parts.month, parts.day, timeZone || "UTC");
}

/**
 * [fromDay, toDay] as REAL instants in the tenant's zone, half-open (SA-869): the filter for a real-instant column
 * (`CreditNote.createdAt`, `Return.refundedAt`; plan A5), so a credit at 23:30 local on the 31st belongs to the 31st.
 * The ONE derivation: sales-facts' `instantWindow` and the accrual net-sales row reader both call it.
 */
export function localInstantWindow(
  fromDay: string,
  toDay: string,
  timeZone?: string | null,
): { gte: Date; lt: Date } {
  const nextDay = addCalendarDays(new Date(`${toDay}T00:00:00.000Z`), 1)
    .toISOString()
    .slice(0, 10);
  return { gte: startOfLocalDay(fromDay, timeZone), lt: startOfLocalDay(nextDay, timeZone) };
}

/** A report's range: the request's days, or a kind relative to the tenant's today (SA-906). */
export type PeriodRange =
  | { fromDay?: string | null; toDay?: string | null }
  | "today"
  | "week"
  | "month"
  | "quarter"
  | "year"
  | { month: number };

export interface TenantPeriod {
  fromDay: string;
  toDay: string;
  /** Filter for a CALENDAR-DATE column (`Invoice.issueDate`, `dueDate`, `Expense.date`): UTC-midnight stamps, NO zone shift. */
  days: { gte: Date; lt: Date };
  /** Filter for a REAL-INSTANT column (`CreditNote.createdAt`, `Return.refundedAt`, `Invoice.writtenOffAt`, `StockMovement.effectiveAt`): the tenant's own days. */
  instants: { gte: Date; lt: Date };
}

const dayStamp = (day: string) => new Date(`${day}T00:00:00.000Z`);
const shiftDay = (day: string, n: number) =>
  addCalendarDays(dayStamp(day), n).toISOString().slice(0, 10);
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * The ONE period every Bookkeeping / analytics report windows on (SA-906, W-728; SA-869's `localInstantWindow` is its instant half).
 * A report is "this month" or "Oct 1 to Oct 31" in the BUSINESS'S OWN calendar, so the zone (the tenant's, `tenantTimeZone`) decides
 * which day it is now and where each instant falls. Two column classes, never mixed:
 *   - `days`: calendar-date columns hold a UTC-midnight stamp that IS the day, so they are filtered by stamps, never zone-shifted
 *     (applying `instants` to them would move every one-day row for a west-of-UTC tenant);
 *   - `instants`: real-instant columns written by the system clock are filtered on the tenant-local day.
 * Kinds are relative to `tenantTodayDay(zone, now)`: to-date (week starts Sunday), and `{ month }` is a whole month (0-based) of
 * the tenant's current year. Explicit `{ fromDay, toDay }` take their first ten characters (a client date); a missing or invalid
 * side defaults to the tenant's Jan 1 / today. A null or unknown zone is UTC. Not used by the regulated period bucket (UTC by contract).
 */
export function tenantPeriod(
  range: PeriodRange,
  zone: string | null | undefined,
  now: Date = new Date(),
): TenantPeriod {
  const today = tenantTodayDay(zone, now);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)); // 1-based
  let fromDay: string;
  let toDay: string;
  if (range === "today") {
    fromDay = toDay = today;
  } else if (range === "week") {
    const dow = dayStamp(today).getUTCDay(); // Sunday = 0
    fromDay = shiftDay(today, -dow);
    toDay = today;
  } else if (range === "month") {
    fromDay = `${year}-${pad2(month)}-01`;
    toDay = today;
  } else if (range === "quarter") {
    fromDay = `${year}-${pad2(Math.floor((month - 1) / 3) * 3 + 1)}-01`;
    toDay = today;
  } else if (range === "year") {
    fromDay = `${year}-01-01`;
    toDay = today;
  } else if ("month" in range) {
    const m = range.month; // 0-based month of the tenant's year
    fromDay = `${year}-${pad2(m + 1)}-01`;
    toDay = shiftDay(`${year + Math.floor((m + 1) / 12)}-${pad2(((m + 1) % 12) + 1)}-01`, -1);
  } else {
    const named = (v?: string | null) =>
      v && parseCalendarDay(v.slice(0, 10)) ? v.slice(0, 10) : null;
    fromDay = named(range.fromDay) ?? `${year}-01-01`;
    toDay = named(range.toDay) ?? today;
  }
  return {
    fromDay,
    toDay,
    days: { gte: dayStamp(fromDay), lt: dayStamp(shiftDay(toDay, 1)) },
    instants: localInstantWindow(fromDay, toDay, zone),
  };
}

/**
 * Optional from/to filters on a CALENDAR-DATE column (list endpoints): a missing side is open. Day stamps, never zone-shifted;
 * `lt` is the day AFTER `to` (so the whole last day is in). Replaces the hand-built `setUTCHours(23, 59, 59, 999)`.
 */
export function calendarDayRange(
  from?: string | null,
  to?: string | null,
): { gte?: Date; lt?: Date } {
  const named = (v?: string | null) =>
    v && parseCalendarDay(v.slice(0, 10)) ? v.slice(0, 10) : null;
  const f = named(from);
  const t = named(to);
  return {
    ...(f ? { gte: dayStamp(f) } : {}),
    ...(t ? { lt: dayStamp(shiftDay(t, 1)) } : {}),
  };
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

/** The tenant's calendar day (YYYY-MM-DD) at `now` in `zone` (UTC when the zone is null): the ONE tenant-today reader. */
export function tenantTodayDay(zone: string | null | undefined, now: Date = new Date()): string {
  return calendarDateFromIso(startOfCalendarDay(now, zone));
}

/**
 * A CLIENT-supplied calendar-date field (e.g. invoice `issueDate`) → the
 * UTC-midnight SYMBOLIC stamp of the literal day it names (#2197): its first
 * ten characters, the house `calendarDayOf` rule. The client's offset and the
 * tenant's zone are both ignored — re-reading a datetime through either shifts
 * the day (`2026-09-25T20:00:00-04:00` is 00:00Z on the 26th). `null` when the
 * value does not name a real calendar day (bad shape, `2026-02-31`, or `2026-13-01`).
 */
export function calendarStampFromInput(raw: string): Date | null {
  const day = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const stamp = new Date(isoFromCalendarDate(day));
  // An out-of-range month or day ("2026-13-01") is Invalid Date, and toISOString() would throw.
  if (Number.isNaN(stamp.getTime())) return null;
  // Date rolls an out-of-range day over ("2026-02-31" → Mar 3) instead of failing.
  return stamp.toISOString().slice(0, 10) === day ? stamp : null;
}

/**
 * #2197/#2256: a client calendar-date field → the stamp of the literal day it names; 400 (naming
 * `field`) when it names none. Every invoice date the client supplies (issueDate, dueDate,
 * depositDueDate) goes through this, never `new Date(raw)`.
 */
export function calendarFieldStamp(raw: string, field: string): Date {
  const stamp = calendarStampFromInput(raw);
  if (!stamp) throw new BadRequestException(`${field} must be a calendar date (YYYY-MM-DD)`);
  return stamp;
}

/** #2197: a client issueDate → the stamp of the literal day it names; 400 when it names none. */
export function issueDateStamp(raw: string): Date {
  return calendarFieldStamp(raw, "issueDate");
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

/**
 * SA-488 (#2493 item 3): THE overdue rule. An invoice is overdue once `now` is past the END of its
 * due day in the tenant's zone (UTC when the zone is unknown) — the whole due day is grace. The
 * cron, the list filter, bookkeeping aging and the KPI summary use `overdueCutoff` (its SQL twin);
 * recomputeStatus uses this. The two agree at every boundary (pinned).
 */
export function isOverdue(
  dueDate: Date | string | null | undefined,
  now: Date = new Date(),
  timeZone?: string | null,
): boolean {
  if (!dueDate) return false;
  // #2518 review: defined FROM the exact SQL twin, never via endOfCalendarDay — that reads the zone
  // offset at a UTC-midnight guess, which is an hour off on a DST eve east of UTC.
  return startOfCalendarDay(dueDate, "UTC").getTime() < overdueCutoff(now, timeZone).getTime();
}

/** The SQL twin of `isOverdue`: `dueDate < overdueCutoff(now, tz)` selects exactly the overdue rows. */
export function overdueCutoff(now: Date = new Date(), timeZone?: string | null): Date {
  return startOfCalendarDay(now, timeZone);
}

/**
 * Payment-term arithmetic on a calendar date, in UTC. `setDate`/`getDate` read LOCAL
 * components, so on a non-UTC host they shift a UTC-midnight instant by the DST delta
 * and can land the due date on the previous calendar day.
 */
export function addCalendarDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
