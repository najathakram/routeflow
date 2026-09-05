import { isoFromCalendarDate } from "../../../../lib/calendar-date";

/**
 * Licence-expiry write helper — extracted verbatim from `licenses.tsx`'s `LicenseSheet.submit`
 * (see B91) so the timestamp construction is directly testable.
 *
 * Writes the calendar-date storage convention (UTC midnight OF the intended day) instead of
 * a LOCAL 23:59:59 instant, which used to shift the stored calendar day for every viewer
 * whose runtime zone is not UTC.
 */
export function buildExpiresAtIso(expiresAt: string): string {
  return isoFromCalendarDate(expiresAt.trim());
}
