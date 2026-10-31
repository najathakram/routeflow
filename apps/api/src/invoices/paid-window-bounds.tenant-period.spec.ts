/**
 * SA-906 / W-728: `tenantPeriod(...).instants` is the SAME window the invoice list's paid filter builds from
 * `paid-window-bounds` (B89): start = tenantCalendarDayStart(from), end = tenantCalendarDayEnd(to), `lt` = end + 1 ms.
 * Zones are data (L-047): west, east, a DST edge, and the null zone.
 */
import { tenantPeriod } from "../common/calendar-date";
import { tenantCalendarDayEnd, tenantCalendarDayStart } from "./paid-window-bounds";

const CASES: Array<[string, string | null, string, string]> = [
  ["Chicago month", "America/Chicago", "2026-10-01", "2026-10-31"],
  ["Sydney month", "Australia/Sydney", "2026-10-01", "2026-10-31"],
  ["Chicago DST fall-back day", "America/Chicago", "2026-11-01", "2026-11-01"],
  ["Sydney DST spring-forward day", "Australia/Sydney", "2026-10-04", "2026-10-04"],
  ["null zone is UTC", null, "2026-10-01", "2026-10-31"],
];

describe("tenantPeriod instants equal the paid-window bounds", () => {
  it.each(CASES)("%s", (_n, zone, from, to) => {
    const p = tenantPeriod({ fromDay: from, toDay: to }, zone);
    expect(p.instants.gte.toISOString()).toBe(tenantCalendarDayStart(from, zone).toISOString());
    expect(p.instants.lt.getTime() - 1).toBe(tenantCalendarDayEnd(to, zone).getTime());
  });
});
