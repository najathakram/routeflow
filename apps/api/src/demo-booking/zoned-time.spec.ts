import {
  isValidTimeZone,
  zonedDateKey,
  zonedDateParts,
  zonedWallClockToUtc,
  zoneOffsetMs,
} from "./zoned-time";

/**
 * The whole booking grid is generated from wall-clock business hours, so a
 * one-hour error here silently books every demo at the wrong time for half the
 * year. These cases pin both US DST transition days in 2026 (spring forward
 * Mar 8, fall back Nov 1).
 */
describe("zonedWallClockToUtc", () => {
  const CHICAGO = "America/Chicago";

  /** Reads the instant back through the zone — the real proof, not arithmetic. */
  const readBack = (instant: Date, timeZone: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(instant);

  it("resolves a winter (CST, UTC-6) morning", () => {
    const instant = zonedWallClockToUtc(2026, 1, 15, 9, 0, CHICAGO);
    expect(instant.toISOString()).toBe("2026-01-15T15:00:00.000Z");
    expect(readBack(instant, CHICAGO)).toBe("09:00");
  });

  it("resolves a summer (CDT, UTC-5) morning", () => {
    const instant = zonedWallClockToUtc(2026, 7, 15, 9, 0, CHICAGO);
    expect(instant.toISOString()).toBe("2026-07-15T14:00:00.000Z");
    expect(readBack(instant, CHICAGO)).toBe("09:00");
  });

  it("keeps 09:00 local on the spring-forward day", () => {
    // Naive `previousDay + 24h` arithmetic lands on 08:00 local here.
    const instant = zonedWallClockToUtc(2026, 3, 8, 9, 0, CHICAGO);
    expect(instant.toISOString()).toBe("2026-03-08T14:00:00.000Z");
    expect(readBack(instant, CHICAGO)).toBe("09:00");
  });

  it("keeps 09:00 local on the fall-back day", () => {
    const instant = zonedWallClockToUtc(2026, 11, 1, 9, 0, CHICAGO);
    expect(instant.toISOString()).toBe("2026-11-01T15:00:00.000Z");
    expect(readBack(instant, CHICAGO)).toBe("09:00");
  });

  it("resolves a nonexistent spring-forward time backwards rather than throwing", () => {
    // 02:30 does not exist on 2026-03-08 in Chicago; documented to land on 01:30.
    const instant = zonedWallClockToUtc(2026, 3, 8, 2, 30, CHICAGO);
    expect(readBack(instant, CHICAGO)).toBe("01:30");
  });

  it("handles a half-hour zone", () => {
    const instant = zonedWallClockToUtc(2026, 6, 1, 9, 0, "Asia/Kolkata");
    expect(instant.toISOString()).toBe("2026-06-01T03:30:00.000Z");
  });

  it("handles a zone east of the date line", () => {
    const instant = zonedWallClockToUtc(2026, 6, 1, 9, 0, "Pacific/Auckland");
    expect(readBack(instant, "Pacific/Auckland")).toBe("09:00");
  });

  it("falls back to UTC for an unknown zone instead of throwing", () => {
    const instant = zonedWallClockToUtc(2026, 6, 1, 9, 0, "Mars/Olympus");
    expect(instant.toISOString()).toBe("2026-06-01T09:00:00.000Z");
  });
});

describe("zoneOffsetMs", () => {
  it("is negative west of UTC", () => {
    expect(zoneOffsetMs(new Date("2026-01-15T15:00:00Z"), "America/Chicago")).toBe(-6 * 3_600_000);
  });

  it("tracks the DST shift", () => {
    expect(zoneOffsetMs(new Date("2026-07-15T15:00:00Z"), "America/Chicago")).toBe(-5 * 3_600_000);
  });

  it("is zero for an unknown zone", () => {
    expect(zoneOffsetMs(new Date("2026-07-15T15:00:00Z"), "Nowhere/Nothing")).toBe(0);
  });
});

describe("zonedDateParts / zonedDateKey", () => {
  it("reports the local day, not the UTC day, across the date boundary", () => {
    // 01:30Z on the 15th is still the 14th in Chicago.
    const instant = new Date("2026-01-15T01:30:00Z");
    expect(zonedDateParts(instant, "America/Chicago")).toMatchObject({
      year: 2026,
      month: 1,
      day: 14,
    });
    expect(zonedDateKey(instant, "America/Chicago")).toBe("2026-01-14");
  });

  it("reports the following day for a zone far east", () => {
    const instant = new Date("2026-01-15T22:00:00Z");
    expect(zonedDateKey(instant, "Asia/Tokyo")).toBe("2026-01-16");
  });

  it("reports the weekday in the target zone", () => {
    // 2026-01-15 is a Thursday (4).
    expect(zonedDateParts(new Date("2026-01-15T18:00:00Z"), "America/Chicago").weekday).toBe(4);
  });
});

describe("isValidTimeZone", () => {
  it.each(["America/Chicago", "Europe/London", "UTC", "Asia/Kolkata"])("accepts %s", (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it.each(["", "Mars/Olympus", "not a zone", "../../etc/passwd"])("rejects %s", (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });
});
