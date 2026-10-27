import { periodBucketOf, monthRange, filingPeriod, periodEndedForTenant } from "./period";

describe("period helpers", () => {
  describe("periodBucketOf", () => {
    it("buckets by UTC year-month", () => {
      expect(periodBucketOf(new Date("2026-07-15T00:00:00Z"))).toBe("2026-07");
      // 23:30 UTC on the last day stays in the month; local tz must not shift it
      expect(periodBucketOf(new Date("2026-01-31T23:30:00Z"))).toBe("2026-01");
    });
  });

  describe("monthRange", () => {
    it("is a half-open UTC [from, to) range", () => {
      const { from, to } = monthRange("2026-07");
      expect(from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
      expect(to.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    });
  });

  describe("filingPeriod", () => {
    it("MONTHLY → single-bucket period", () => {
      const p = filingPeriod("MONTHLY", 2026, 7);
      expect(p.periodKey).toBe("2026-07");
      expect(p.buckets).toEqual(["2026-07"]);
      expect(p.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
      expect(p.to.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    });

    it("QUARTERLY → three consecutive month buckets", () => {
      const p = filingPeriod("QUARTERLY", 2026, 2);
      expect(p.periodKey).toBe("2026-Q2");
      expect(p.buckets).toEqual(["2026-04", "2026-05", "2026-06"]);
      expect(p.from.toISOString()).toBe("2026-04-01T00:00:00.000Z");
      expect(p.to.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    });

    it("QUARTERLY Q1 and Q4 boundaries", () => {
      expect(filingPeriod("QUARTERLY", 2026, 1).buckets).toEqual(["2026-01", "2026-02", "2026-03"]);
      const q4 = filingPeriod("QUARTERLY", 2026, 4);
      expect(q4.buckets).toEqual(["2026-10", "2026-11", "2026-12"]);
      expect(q4.to.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    });

    it("ANNUAL → twelve buckets spanning the year", () => {
      const p = filingPeriod("ANNUAL", 2026, 1);
      expect(p.periodKey).toBe("2026");
      expect(p.buckets).toHaveLength(12);
      expect(p.buckets[0]).toBe("2026-01");
      expect(p.buckets[11]).toBe("2026-12");
      expect(p.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(p.to.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    });

    it("rejects out-of-range indices", () => {
      expect(() => filingPeriod("MONTHLY", 2026, 0)).toThrow(RangeError);
      expect(() => filingPeriod("MONTHLY", 2026, 13)).toThrow(RangeError);
      expect(() => filingPeriod("QUARTERLY", 2026, 5)).toThrow(RangeError);
    });
  });

  describe("periodEndedForTenant (SA-995: the tenant's own day, no grace)", () => {
    const end = new Date("2026-11-01T00:00:00.000Z"); // the filing period 2026-10 ends here
    it("a Chicago tenant is still on 10-31 at 2026-11-01T03:00Z: not ended", () => {
      expect(periodEndedForTenant(end, "America/Chicago", new Date("2026-11-01T03:00:00Z"))).toBe(
        false,
      );
    });
    it("the same tenant at 2026-11-01T06:00Z is on 11-01: ended", () => {
      expect(periodEndedForTenant(end, "America/Chicago", new Date("2026-11-01T06:00:00Z"))).toBe(
        true,
      );
    });
    it("a Sydney tenant has already reached 11-01 at 2026-10-31T13:00Z", () => {
      expect(periodEndedForTenant(end, "Australia/Sydney", new Date("2026-10-31T13:00:00Z"))).toBe(
        true,
      );
    });
    it("no zone reads as UTC", () => {
      expect(periodEndedForTenant(end, null, new Date("2026-10-31T23:59:59Z"))).toBe(false);
      expect(periodEndedForTenant(end, null, new Date("2026-11-01T00:00:00Z"))).toBe(true);
    });
  });
});
