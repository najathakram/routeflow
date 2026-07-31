import {
  DEMAND_RANGES,
  type DemandRange,
  bucketIndexOf,
  demandWindow,
  isDemandRange,
} from "./demand-range";

/**
 * Every date here is a frozen literal — `demandWindow` takes `now` as a parameter and
 * never reads the clock, so these assertions are exact and need no fake timers (this
 * repo has none). That injectability is the whole point of the helper's signature.
 */
describe("demand-range", () => {
  describe("isDemandRange", () => {
    it.each(DEMAND_RANGES)("accepts %s", (r) => {
      expect(isDemandRange(r)).toBe(true);
    });

    // Casing/whitespace normalization is the controller's job, not the guard's.
    it.each(["6mo", "1yr", "30D", "", "day", "30", null, undefined, 7, {}])("rejects %p", (v) => {
      expect(isDemandRange(v)).toBe(false);
    });
  });

  describe("window shape", () => {
    it("30d ends on today and spans 30 daily buckets", () => {
      const win = demandWindow(new Date("2026-07-15T18:30:00Z"), "30d");
      expect(win.granularity).toBe("day");
      expect(win.buckets).toHaveLength(30);
      expect(win.buckets[29].date).toBe("2026-07-15");
      expect(win.buckets[0].date).toBe("2026-06-16");
      expect(win.from.toISOString()).toBe("2026-06-16T00:00:00.000Z");
      // Half-open: `to` is the exclusive end, i.e. the day AFTER the last bucket.
      expect(win.to.toISOString()).toBe("2026-07-16T00:00:00.000Z");
    });

    it("6m spans 26 Monday-anchored weekly buckets containing today", () => {
      const now = new Date("2026-07-15T18:30:00Z"); // a Wednesday
      const win = demandWindow(now, "6m");
      expect(win.granularity).toBe("week");
      expect(win.buckets).toHaveLength(26);
      // Assert the anchoring rule structurally rather than hard-coding a weekday.
      for (const b of win.buckets) {
        expect(new Date(`${b.date}T00:00:00.000Z`).getUTCDay()).toBe(1);
      }
      expect(win.from.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(win.to.getTime()).toBeGreaterThan(now.getTime());
    });

    it("1y spans 12 month-start buckets ending on the current month", () => {
      const win = demandWindow(new Date("2026-07-15T18:30:00Z"), "1y");
      expect(win.granularity).toBe("month");
      expect(win.buckets).toHaveLength(12);
      expect(win.buckets.every((b) => b.date.endsWith("-01"))).toBe(true);
      expect(win.buckets[11].date).toBe("2026-07-01");
      expect(win.buckets[0].date).toBe("2025-08-01");
    });

    it("5y spans 60 monthly buckets", () => {
      const win = demandWindow(new Date("2026-07-15T18:30:00Z"), "5y");
      expect(win.granularity).toBe("month");
      expect(win.buckets).toHaveLength(60);
      expect(win.buckets[59].date).toBe("2026-07-01");
      expect(win.buckets[0].date).toBe("2021-08-01");
    });

    // One loop that would catch an off-by-one in any of the four windows.
    it.each(DEMAND_RANGES)("%s buckets are contiguous and match from/to", (range) => {
      const win = demandWindow(new Date("2026-07-15T18:30:00Z"), range as DemandRange);
      expect(win.buckets[0].date).toBe(win.from.toISOString().slice(0, 10));
      expect(win.buckets[win.buckets.length - 1].end).toBe(win.to.toISOString().slice(0, 10));
      for (let i = 0; i < win.buckets.length - 1; i++) {
        expect(win.buckets[i].end).toBe(win.buckets[i + 1].date);
      }
    });
  });

  describe("date-math traps", () => {
    it("5y crosses year boundaries without month overflow", () => {
      // 59 months back from January spans five year rollovers.
      const win = demandWindow(new Date("2026-01-15T00:00:00Z"), "5y");
      expect(win.buckets[0].date).toBe("2021-02-01");
      expect(win.buckets[59].date).toBe("2026-01-01");
    });

    it("does not skid when now is the 31st (the setMonth trap)", () => {
      // A naive setMonth(m - 11) on a day-31 Date lands on 2025-05-01, not 2025-04-01.
      const win = demandWindow(new Date("2026-03-31T12:00:00Z"), "1y");
      expect(win.buckets[0].date).toBe("2025-04-01");
      expect(win.buckets[11].date).toBe("2026-03-01");
    });

    it("anchors on the UTC day, not the host's local day", () => {
      // The getRevenueTrend bug: on any UTC-behind host a local-time implementation
      // buckets 02:00Z on Jan 1 into December. This is the highest-value assertion here.
      const win = demandWindow(new Date("2026-01-01T02:00:00.000Z"), "1y");
      expect(win.buckets[11].date).toBe("2026-01-01");
    });

    it("includes Feb 29 in a leap year", () => {
      const win = demandWindow(new Date("2024-03-01T00:00:00Z"), "30d");
      expect(win.buckets.map((b) => b.date)).toContain("2024-02-29");
    });
  });

  describe("bucketIndexOf", () => {
    const now = new Date("2026-07-15T18:30:00Z");

    it.each(DEMAND_RANGES)("%s maps bucket starts and ends to the right index", (range) => {
      const win = demandWindow(now, range as DemandRange);
      const last = win.buckets.length - 1;
      expect(bucketIndexOf(win, new Date(`${win.buckets[0].date}T00:00:00.000Z`))).toBe(0);
      expect(bucketIndexOf(win, new Date(`${win.buckets[3].date}T00:00:00.000Z`))).toBe(3);
      expect(bucketIndexOf(win, new Date(`${win.buckets[last].date}T00:00:00.000Z`))).toBe(last);
      // A bucket's exclusive end belongs to the NEXT bucket.
      expect(bucketIndexOf(win, new Date(`${win.buckets[2].end}T00:00:00.000Z`))).toBe(3);
    });

    it("returns -1 outside the window", () => {
      const win = demandWindow(now, "30d");
      expect(bucketIndexOf(win, win.to)).toBe(-1);
      expect(bucketIndexOf(win, new Date(win.from.getTime() - 1))).toBe(-1);
      expect(bucketIndexOf(win, new Date("2020-01-01T00:00:00Z"))).toBe(-1);
    });

    it("floors a mid-bucket timestamp to its bucket", () => {
      const win = demandWindow(now, "30d");
      // Late in the day must still land on that day's bucket, not the next.
      expect(bucketIndexOf(win, new Date(`${win.buckets[7].date}T23:59:59.999Z`))).toBe(7);
    });
  });

  describe("purity", () => {
    it("is deterministic for the same now", () => {
      const now = new Date("2026-07-15T18:30:00Z");
      expect(demandWindow(now, "6m")).toEqual(demandWindow(now, "6m"));
    });

    it("does not mutate the injected now", () => {
      const now = new Date("2026-03-31T12:00:00Z");
      const snapshot = now.toISOString();
      DEMAND_RANGES.forEach((r) => demandWindow(now, r as DemandRange));
      expect(now.toISOString()).toBe(snapshot);
    });
  });
});
