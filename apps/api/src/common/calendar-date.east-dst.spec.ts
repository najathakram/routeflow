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

  // Oracle (SA-985): no hard-coded transition day and no offset, and the local date is read with Intl directly (never
  // the code under test). For each of SA-985's 10 zones the 2026 offset changes are found by scanning every UTC hour;
  // the days around each change are then checked against the earliest instant whose Intl local date is that day,
  // found by scanning minutes. Zero mismatches.
  describe("oracle: SA-985's 10 zones over the 2026 transition days", () => {
    const ZONES = [
      "Australia/Sydney",
      "Pacific/Auckland",
      "Asia/Beirut",
      "Africa/Cairo",
      "America/Havana",
      "America/Santiago",
      "Atlantic/Azores",
      "America/Chicago",
      "America/New_York",
      "America/Los_Angeles",
    ];
    const HOUR = 3600_000;
    const MINUTE = 60_000;

    const readers = (zone: string) => {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone });
      const wall = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const offsetMin = (ms: number) => {
        const p = Object.fromEntries(
          wall.formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
        );
        const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
        return (shown - Math.floor(ms / MINUTE) * MINUTE) / MINUTE;
      };
      return { localDay: (ms: number) => day.format(new Date(ms)), offsetMin };
    };

    const transitionDays = (zone: string): string[] => {
      const { localDay, offsetMin } = readers(zone);
      const days = new Set<string>();
      const from = Date.UTC(2026, 0, 1);
      const to = Date.UTC(2027, 0, 1);
      let prev = offsetMin(from);
      for (let ms = from + HOUR; ms < to; ms += HOUR) {
        const cur = offsetMin(ms);
        if (cur !== prev) for (const k of [-24, 0, 24]) days.add(localDay(ms + k * HOUR));
        prev = cur;
      }
      return [...days].filter((d) => d.startsWith("2026-")).sort();
    };

    it("startOfLocalDay is the earliest instant on the named local day, on every transition day", () => {
      const mismatches: string[] = [];
      let checked = 0;
      for (const zone of ZONES) {
        const { localDay } = readers(zone);
        for (const day of transitionDays(zone)) {
          const noon = Date.parse(`${day}T12:00:00.000Z`);
          let earliest = -1;
          for (let ms = noon - 40 * HOUR; ms <= noon + 12 * HOUR; ms += MINUTE) {
            if (localDay(ms) === day) {
              earliest = ms;
              break;
            }
          }
          checked++;
          const got = startOfLocalDay(day, zone).getTime();
          if (got !== earliest) {
            mismatches.push(
              `${zone} ${day}: got ${new Date(got).toISOString()} want ${new Date(earliest).toISOString()}`,
            );
          }
        }
      }
      expect(checked).toBeGreaterThanOrEqual(ZONES.length * 4);
      expect(mismatches).toEqual([]);
    });
  });
});
