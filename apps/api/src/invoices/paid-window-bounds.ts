import { endOfCalendarDay } from "../common/calendar-date";
import { calendarDayOf } from "./settled-date-filter";

// Lifted VERBATIM out of InvoicesService (size ratchet; S19 must not grow it). Neither used `this`.

/**
 * The real tenant-local midnight instant that BEGINS the calendar day
 * `dateStr` (a `YYYY-MM-DD` value, e.g. a `dateFrom` query param) encodes —
 * the paidAt/settledAt-window counterpart to `endOfCalendarDay` (B89,
 * L-047: paidAt is a real instant, so its day bounds must be evaluated in
 * the TENANT's own timezone, never the host clock's). Composed from the
 * shared `endOfCalendarDay` helper rather than re-deriving the UTC-offset
 * math a second time (L-047/L-072): the instant 1ms after the PREVIOUS
 * calendar day's tenant-local end is exactly this day's tenant-local start.
 */
export function tenantCalendarDayStart(dateStr: string, timeZone: string | null): Date {
  const prevDay = new Date(`${calendarDayOf(dateStr, "dateFrom")}T00:00:00.000Z`);
  prevDay.setUTCDate(prevDay.getUTCDate() - 1);
  return new Date(endOfCalendarDay(prevDay, timeZone).getTime() + 1);
}

/**
 * The real tenant-local instant that ENDS the calendar day `dateStr` encodes
 * — the `dateTo` counterpart to `tenantCalendarDayStart`. The param is
 * normalised through `calendarDayOf` FIRST so an unparsable value is
 * rejected with a 400 instead of reaching Prisma as an `Invalid Date` bound,
 * and a full ISO datetime resolves to the same window as its date-only form.
 */
export function tenantCalendarDayEnd(dateStr: string, timeZone: string | null): Date {
  return endOfCalendarDay(new Date(`${calendarDayOf(dateStr, "dateTo")}T00:00:00.000Z`), timeZone);
}
