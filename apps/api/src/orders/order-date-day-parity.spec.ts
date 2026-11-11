import { tenantDayOf } from "@routeflow/pricing";
import { tenantTodayDay } from "../common/calendar-date";

/**
 * W-1188 review SHOULD (reader A): the pricing package judges the tenant's day with `tenantDayOf`, the API's gate and
 * delivery step with `tenantTodayDay`. Two helpers must name the same day for every zone and instant, or the gate
 * and the audit drift apart (an evening order refused by one and filed under another day by the other).
 */
describe("tenantDayOf (pricing) equals tenantTodayDay (api)", () => {
  const instants = [
    "2026-11-09T12:00:00.000Z",
    "2026-11-10T05:30:00.000Z", // Chicago evening of Nov 9
    "2026-03-08T07:30:00.000Z", // US spring-forward day
    "2026-11-01T05:30:00.000Z", // US fall-back day
    "2026-12-31T11:30:00.000Z", // Auckland already Jan 1
  ].map((s) => new Date(s));
  const zones: Array<string | null> = [
    "UTC",
    "America/Chicago",
    "Pacific/Auckland",
    null,
    "",
    "Not/AZone",
  ];

  for (const zone of zones) {
    it(`zone ${JSON.stringify(zone)}: same day at every instant`, () => {
      for (const at of instants) {
        expect({ at: at.toISOString(), day: tenantDayOf(at, zone) }).toEqual({
          at: at.toISOString(),
          day: tenantTodayDay(zone, at),
        });
      }
    });
  }
});
