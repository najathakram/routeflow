import { calendarDayBounds } from "./calendar-date";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekdayIndex(instant: Date, timeZone: string): number {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(instant);
    const i = WEEKDAYS.indexOf(name);
    if (i >= 0) return i;
  } catch {
    // invalid IANA zone: fall through to UTC
  }
  return instant.getUTCDay();
}

/**
 * The start of the business's current week — Sunday 00:00 in `timeZone` — as a real UTC instant.
 * DST-safe (each local midnight is resolved on its own calendar day); an invalid zone falls back to
 * UTC, never throws. One helper for the dashboard "Shipped this week" card AND the orders list's week
 * view, so the card count always equals the list total.
 */
export function startOfTenantWeek(now: Date, timeZone: string): Date {
  const today = calendarDayBounds(timeZone, now).start;
  const back = weekdayIndex(now, timeZone);
  if (back === 0) return today;
  // Noon of the target day sits inside it even across a 1h DST shift.
  const noonThen = new Date(today.getTime() - back * 86_400_000 + 12 * 3_600_000);
  return calendarDayBounds(timeZone, noonThen).start;
}
