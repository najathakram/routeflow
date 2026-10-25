import { startOfCalendarDay, startOfLocalDay } from "./calendar-date";

/**
 * #3686: the zone's offset is taken at the local midnight itself, not at 00:00Z. East of UTC the two instants
 * sit on opposite sides of a DST change on the change day, so a single pass stored the PREVIOUS day. Each case
 * pins the instant of local 00:00 and that the day reads back as the day that was entered.
 */
describe("startOfLocalDay on the DST-change day (#3686)", () => {
  const cases: Array<[string, string, string]> = [
    ["Pacific/Auckland", "2026-09-27", "2026-09-26T12:00:00.000Z"], // spring forward 02:00 NZST -> 03:00, midnight is +12
    ["Pacific/Auckland", "2026-04-05", "2026-04-04T11:00:00.000Z"], // fall back 03:00 NZDT -> 02:00, midnight is +13
    ["Australia/Sydney", "2026-10-04", "2026-10-03T14:00:00.000Z"], // spring forward, midnight is +10
    ["Australia/Sydney", "2026-04-05", "2026-04-04T13:00:00.000Z"], // fall back, midnight is +11
    ["America/New_York", "2026-03-08", "2026-03-08T05:00:00.000Z"], // US spring forward
    ["America/New_York", "2026-11-01", "2026-11-01T04:00:00.000Z"], // US fall back
    ["America/Havana", "2026-03-08", "2026-03-08T05:00:00.000Z"], // guard: spring forward AT 00:00, the day starts at 01:00 CDT
    ["Atlantic/Azores", "2026-03-29", "2026-03-29T01:00:00.000Z"], // guard: spring forward AT 00:00, the day starts at 01:00 local
    ["Etc/GMT+12", "2026-09-27", "2026-09-27T12:00:00.000Z"], // UTC-12 control
    ["Pacific/Kiritimati", "2026-09-27", "2026-09-26T10:00:00.000Z"], // UTC+14 control
  ];

  it.each(cases)("%s %s starts at %s and reads back as the same day", (zone, day, instant) => {
    const start = startOfLocalDay(day, zone);
    expect(start.toISOString()).toBe(instant);
    expect(startOfCalendarDay(start, zone).toISOString().slice(0, 10)).toBe(day);
  });

  // Oracle (SA-985): independent of any hard-coded offset. The day starts at the earliest instant whose local date is
  // the named day, found by scanning minutes around the day with the same host tzdata the code reads.
  it.each(cases.map(([zone, day]) => [zone, day]))(
    "%s %s is the earliest instant on that local day",
    (zone, day) => {
      const localDay = (ms: number) =>
        startOfCalendarDay(new Date(ms), zone).toISOString().slice(0, 10);
      const noon = Date.parse(day + "T12:00:00.000Z");
      let earliest = noon;
      for (let ms = noon - 40 * 3600_000; ms <= noon; ms += 60_000) {
        if (localDay(ms) === day) {
          earliest = ms;
          break;
        }
      }
      expect(startOfLocalDay(day, zone).getTime()).toBe(earliest);
    },
  );
});
