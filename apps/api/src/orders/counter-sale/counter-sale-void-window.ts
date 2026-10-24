import {
  addCalendarDays,
  calendarDateFromIso,
  isoFromCalendarDate,
  startOfCalendarDay,
  startOfLocalDay,
} from "../../common/calendar-date";
import { effectiveZone } from "./counter-sale-today.service";

/**
 * [start, end) of the calendar day containing `now` in the tenant's zone, as REAL instants: the same cut
 * counter-sale-today.service.ts makes for "Today's sales" (shared helpers, DST-safe), so the void window and the
 * register's day can never disagree. `tz` is the tenant's IANA zone (null/unknown = UTC, like the today read).
 */
export function tenantDayWindow(now: Date, tz: string | null): { start: Date; end: Date } {
  const zone = effectiveZone(tz);
  const today = calendarDateFromIso(startOfCalendarDay(now, zone));
  const nextDay = calendarDateFromIso(addCalendarDays(new Date(isoFromCalendarDate(today)), 1));
  return { start: startOfLocalDay(today, zone), end: startOfLocalDay(nextDay, zone) };
}
