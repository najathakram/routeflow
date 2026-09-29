import { startOfCalendarDay, startOfLocalDay } from "./calendar-date";

/**
 * #2118 (plan A5): the sales-facts layer turns a window of tenant calendar days into REAL
 * instant bounds for the credit-note (`createdAt`) and refund (`refundedAt`) reads, and maps
 * each such instant back to its tenant calendar day with `startOfCalendarDay`. These pins keep
 * the two directions consistent — including across both US DST changes — so a credit lands
 * in the same bucket the window bounds say it belongs to.
 */
describe("startOfLocalDay", () => {
  const NY = "America/New_York";
  const iso = (d: Date) => d.toISOString();

  it("is UTC midnight for UTC, and for a null/blank/unknown zone (never throws on a zone)", () => {
    expect(iso(startOfLocalDay("2026-09-01", "UTC"))).toBe("2026-09-01T00:00:00.000Z");
    expect(iso(startOfLocalDay("2026-09-01", null))).toBe("2026-09-01T00:00:00.000Z");
    expect(iso(startOfLocalDay("2026-09-01", ""))).toBe("2026-09-01T00:00:00.000Z");
    expect(iso(startOfLocalDay("2026-09-01", "Not/AZone"))).toBe("2026-09-01T00:00:00.000Z");
  });

  it("reads the zone's real offset on that day (EDT −4, EST −5)", () => {
    expect(iso(startOfLocalDay("2026-09-01", NY))).toBe("2026-09-01T04:00:00.000Z");
    expect(iso(startOfLocalDay("2026-01-15", NY))).toBe("2026-01-15T05:00:00.000Z");
  });

  it("spans the 23-hour spring-forward day and the 25-hour fall-back day exactly", () => {
    // 2026-03-08: clocks jump 02:00 → 03:00; midnight itself is still EST.
    expect(iso(startOfLocalDay("2026-03-08", NY))).toBe("2026-03-08T05:00:00.000Z");
    expect(iso(startOfLocalDay("2026-03-09", NY))).toBe("2026-03-09T04:00:00.000Z");
    // 2026-11-01: clocks fall back 02:00 → 01:00; midnight itself is still EDT.
    expect(iso(startOfLocalDay("2026-11-01", NY))).toBe("2026-11-01T04:00:00.000Z");
    expect(iso(startOfLocalDay("2026-11-02", NY))).toBe("2026-11-02T05:00:00.000Z");
  });

  it("agrees with startOfCalendarDay at both edges of a local day (the round trip the layer relies on)", () => {
    for (const day of ["2026-03-08", "2026-03-09", "2026-11-01", "2026-09-30", "2026-12-31"]) {
      const start = startOfLocalDay(day, NY);
      const next = new Date(`${day}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const end = startOfLocalDay(next.toISOString().slice(0, 10), NY);
      expect(iso(startOfCalendarDay(start, NY))).toBe(`${day}T00:00:00.000Z`);
      expect(iso(startOfCalendarDay(new Date(end.getTime() - 1), NY))).toBe(`${day}T00:00:00.000Z`);
      expect(iso(startOfCalendarDay(end, NY))).not.toBe(`${day}T00:00:00.000Z`);
    }
  });

  it("plan §E: a credit at 23:30 local on the 31st belongs to that day (and so that month)", () => {
    // 2026-08-31 23:30 EDT is 2026-09-01 03:30 UTC — a UTC key would move it to September.
    const at = new Date("2026-09-01T03:30:00.000Z");
    expect(iso(startOfCalendarDay(at, NY))).toBe("2026-08-31T00:00:00.000Z");
    expect(at.getTime()).toBeLessThan(startOfLocalDay("2026-09-01", NY).getTime());
  });

  it("refuses a value that is not a real YYYY-MM-DD day", () => {
    for (const bad of ["2026-02-30", "2026-9-1", "2026-09-01T00:00:00Z", ""]) {
      expect(() => startOfLocalDay(bad, NY)).toThrow(RangeError);
    }
  });
});
