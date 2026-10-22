import { calendarDayBounds, calendarDayInZone } from "./calendar-date";

/**
 * T12 (mirror pin) — `calendarDayBounds` is triplicated verbatim across
 * `apps/api/src/common/calendar-date.ts`, `apps/web/lib/calendar-date.ts` and
 * `apps/mobile/lib/calendar-date.ts`. These three cases are asserted
 * IDENTICALLY in all three packages so a copy that drifts (or whose
 * `hourCycle`/hour-24 correction breaks) fails here instead of silently
 * handing wrong day boundaries to the first caller added later.
 *
 * Semantics being pinned: the interval is half-open — `end` is the EXCLUSIVE
 * next-day boundary, not 23:59:59.999 — and the second argument is an
 * INSTANT, resolved to a calendar day as observed in `timeZone`.
 */
describe("calendarDayBounds — T12 mirror pin", () => {
  it("returns the plain UTC day for zone UTC", () => {
    const { start, end } = calendarDayBounds("UTC", new Date("2026-06-10T00:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-11T00:00:00.000Z");
  });

  it("resolves UTC midnight Mar 8 to the PREVIOUS calendar day in America/New_York", () => {
    const { start, end } = calendarDayBounds(
      "America/New_York",
      new Date("2026-03-08T00:00:00.000Z"),
    );
    expect(start.toISOString()).toBe("2026-03-07T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(24 * 3600 * 1000);
  });

  it("spans only 23 hours on the America/New_York spring-forward day", () => {
    const { start, end } = calendarDayBounds(
      "America/New_York",
      new Date("2026-03-08T12:00:00.000Z"),
    );
    expect(start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(23 * 3600 * 1000);
  });
});

describe("calendarDayInZone — the business's today (row 735a)", () => {
  it("is the day in the zone, not the UTC day", () => {
    const now = new Date("2026-10-22T05:00:00Z");
    expect(calendarDayInZone("Pacific/Honolulu", now)).toBe("2026-10-21");
    expect(calendarDayInZone("UTC", now)).toBe("2026-10-22");
    expect(calendarDayInZone("Pacific/Auckland", new Date("2026-10-22T20:00:00Z"))).toBe(
      "2026-10-23",
    );
  });

  it("follows CST, not the CDT offset, on the 25-hour fall-back day", () => {
    expect(calendarDayInZone("America/Chicago", new Date("2026-11-01T06:30:00Z"))).toBe(
      "2026-11-01",
    );
    expect(calendarDayInZone("America/Chicago", new Date("2026-11-01T07:30:00Z"))).toBe(
      "2026-11-01",
    );
    expect(calendarDayInZone("America/Chicago", new Date("2026-11-02T05:30:00Z"))).toBe(
      "2026-11-01",
    );
    expect(calendarDayInZone("America/Chicago", new Date("2026-11-02T06:30:00Z"))).toBe(
      "2026-11-02",
    );
  });

  it("an unknown zone reads the UTC day and never throws", () => {
    expect(calendarDayInZone("Not/AZone", new Date("2026-10-22T05:00:00Z"))).toBe("2026-10-22");
  });
});
