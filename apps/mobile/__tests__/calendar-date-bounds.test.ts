import { calendarDayBounds } from "../lib/calendar-date";

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
