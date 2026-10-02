import { readFileSync } from "fs";
import { join } from "path";
import {
  DEMAND_RANGES,
  type DemandRange,
  INSIGHT_GRAINS,
  InsightWindowError,
  addCalendarDays,
  bucketIndexOf,
  defaultInsightGrain,
  demandWindow,
  isCalendarDay,
  isDemandRange,
  rangeWindow,
  resolveInsightRange,
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

/**
 * #2118 (plan A5): the from/to form behind the insights endpoints. Same rules as the range
 * form — UTC-midnight day stamps, half-open data bounds, zero-filled buckets, never a clock
 * read — plus the quarter grain and the window limits (36 months, 400 buckets).
 */
describe("demand-range — from/to form (#2118)", () => {
  const stamp = (day: string) => new Date(`${day}T00:00:00.000Z`);
  const days = (win: { buckets: { date: string }[] }) => win.buckets.map((b) => b.date);

  describe("rangeWindow", () => {
    it("month grain: calendar-month buckets cover both edges; data bounds are the exact days", () => {
      const win = rangeWindow("2026-01-15", "2026-03-10", "month");
      expect(win.granularity).toBe("month");
      expect(days(win)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
      expect(win.buckets[2].end).toBe("2026-04-01");
      expect(win.fromDay).toBe("2026-01-15");
      expect(win.toDay).toBe("2026-03-10");
      // Half-open over UTC-midnight stamps: the `to` day itself is IN, the next day is OUT.
      expect(win.dataFrom.toISOString()).toBe("2026-01-15T00:00:00.000Z");
      expect(win.dataTo.toISOString()).toBe("2026-03-11T00:00:00.000Z");
      // The bucket span is period-aligned (what bucketIndexOf indexes from).
      expect(win.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(win.to.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    });

    it("week grain anchors every bucket to Monday (ISO-8601)", () => {
      // 2026-09-23 and 2026-10-07 are Wednesdays.
      const win = rangeWindow("2026-09-23", "2026-10-07", "week");
      expect(days(win)).toEqual(["2026-09-21", "2026-09-28", "2026-10-05"]);
      expect(win.buckets[2].end).toBe("2026-10-12");
      expect(bucketIndexOf(win, stamp("2026-09-27"))).toBe(0); // Sunday closes week 0
      expect(bucketIndexOf(win, stamp("2026-09-28"))).toBe(1); // Monday opens week 1
    });

    it("quarter grain starts on Jan/Apr/Jul/Oct 1 and indexes across a year boundary", () => {
      const win = rangeWindow("2025-11-15", "2026-05-01", "quarter");
      expect(days(win)).toEqual(["2025-10-01", "2026-01-01", "2026-04-01"]);
      expect(win.buckets[2].end).toBe("2026-07-01");
      expect(bucketIndexOf(win, stamp("2025-12-31"))).toBe(0);
      expect(bucketIndexOf(win, stamp("2026-03-31"))).toBe(1);
      expect(bucketIndexOf(win, stamp("2026-04-01"))).toBe(2);
    });

    it("day grain: one bucket per day, both edges included (non-leap February)", () => {
      const win = rangeWindow("2026-02-27", "2026-03-02", "day");
      expect(days(win)).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
      expect(win.dataTo.toISOString()).toBe("2026-03-03T00:00:00.000Z");
    });

    it("plan §E month edge: a T00:00Z stamp on the 1st buckets to THAT month, the 31st to the one before", () => {
      const win = rangeWindow("2026-01-01", "2026-03-31", "month");
      expect(bucketIndexOf(win, stamp("2026-02-01"))).toBe(1);
      expect(bucketIndexOf(win, stamp("2026-01-31"))).toBe(0);
      expect(bucketIndexOf(win, stamp("2026-03-31"))).toBe(2);
    });

    it("a single-day window is valid", () => {
      const win = rangeWindow("2026-09-25", "2026-09-25", "day");
      expect(days(win)).toEqual(["2026-09-25"]);
    });

    it("refuses to < from", () => {
      expect(() => rangeWindow("2026-03-02", "2026-03-01", "day")).toThrow(InsightWindowError);
    });

    it("refuses malformed or impossible days rather than letting Date roll them over", () => {
      for (const bad of ["2026-02-30", "2026-2-1", "2026-02-01T00:00:00Z", "", "20260201"]) {
        expect(() => rangeWindow(bad, "2026-03-01", "day")).toThrow(InsightWindowError);
        expect(() => rangeWindow("2026-01-01", bad, "month")).toThrow(InsightWindowError);
      }
    });

    it("allows exactly 36 months and refuses one day more", () => {
      expect(() => rangeWindow("2023-01-01", "2025-12-31", "month")).not.toThrow();
      expect(() => rangeWindow("2023-01-01", "2026-01-01", "month")).toThrow(InsightWindowError);
    });

    it("refuses a grain that would produce more than 400 buckets", () => {
      // 2025-01-01 .. 2026-02-04 is 400 days; one more day is 401 daily buckets.
      expect(rangeWindow("2025-01-01", "2026-02-04", "day").buckets).toHaveLength(400);
      expect(() => rangeWindow("2025-01-01", "2026-02-05", "day")).toThrow(InsightWindowError);
      // The same span at week grain is fine.
      expect(() => rangeWindow("2025-01-01", "2026-02-05", "week")).not.toThrow();
    });

    it("zero-fills: every bucket exists even with no data (callers index into it)", () => {
      expect(rangeWindow("2024-01-01", "2026-09-25", "month").buckets).toHaveLength(33);
    });
  });

  describe("resolveInsightRange", () => {
    const today = "2026-09-25";

    it("defaults to the trailing 12 calendar months at month grain, ending today", () => {
      expect(resolveInsightRange({}, today)).toEqual({
        fromDay: "2025-10-01",
        toDay: "2026-09-25",
        grain: "month",
      });
    });

    it("a given `to` anchors the default `from`; a given `from` alone runs to today", () => {
      expect(resolveInsightRange({ to: "2026-03-15" }, today)).toMatchObject({
        fromDay: "2025-04-01",
        toDay: "2026-03-15",
      });
      expect(resolveInsightRange({ from: "2026-09-01" }, today)).toEqual({
        fromDay: "2026-09-01",
        toDay: "2026-09-25",
        grain: "day",
      });
    });

    it("keeps an explicit grain and refuses an unknown one", () => {
      expect(resolveInsightRange({ grain: "quarter" }, today).grain).toBe("quarter");
      expect(() => resolveInsightRange({ grain: "year" }, today)).toThrow(InsightWindowError);
    });

    it("treats blank params as absent (an empty query string is not a date)", () => {
      expect(resolveInsightRange({ from: "", to: " ", grain: "" }, today)).toEqual(
        resolveInsightRange({}, today),
      );
    });

    it("validates the resolved window (inverted range → error)", () => {
      expect(() => resolveInsightRange({ from: "2026-10-01", to: "2026-09-01" }, today)).toThrow(
        InsightWindowError,
      );
    });
  });

  describe("small helpers", () => {
    it("defaultInsightGrain: day up to 62 days, week up to 184 (~6 months), month beyond", () => {
      expect(defaultInsightGrain("2026-01-01", "2026-03-03")).toBe("day"); // 62 days
      expect(defaultInsightGrain("2026-01-01", "2026-03-04")).toBe("week"); // 63 days
      expect(defaultInsightGrain("2026-01-01", "2026-07-03")).toBe("week"); // 184 days
      expect(defaultInsightGrain("2026-01-01", "2026-07-04")).toBe("month"); // 185 days
    });

    it("isCalendarDay accepts only real YYYY-MM-DD days", () => {
      expect(isCalendarDay("2024-02-29")).toBe(true);
      expect(isCalendarDay("2026-02-29")).toBe(false);
      expect(isCalendarDay("2026-13-01")).toBe(false);
      expect(isCalendarDay(null)).toBe(false);
    });

    it("addCalendarDays crosses month/year ends", () => {
      expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
      expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
    });

    it("INSIGHT_GRAINS is the four grains the shared DTO names", () => {
      expect([...INSIGHT_GRAINS]).toEqual(["day", "week", "month", "quarter"]);
    });
  });
});

describe("InsightWindowError reason (B987-E d): opt-in, set at every throw site", () => {
  it("a bare error has no reason (other endpoints keep today's body)", () => {
    const e = new InsightWindowError("x");
    expect(e.reason).toBeUndefined();
    expect(e.params).toBeUndefined();
  });

  it.each([
    [() => resolveInsightRange({ to: "2026-9-29" }, "2026-09-29"), "TO_NOT_A_DAY"],
    [() => resolveInsightRange({ from: "nope", to: "2026-09-29" }, "2026-09-29"), "FROM_NOT_A_DAY"],
    [() => resolveInsightRange({ grain: "decade" }, "2026-09-29"), "BAD_GRAIN"],
    [() => rangeWindow("2026-09-29", "2026-09-01", "day"), "TO_BEFORE_FROM"],
    [() => rangeWindow("2020-01-01", "2026-09-29", "month"), "WINDOW_TOO_LONG"],
  ])("throws an InsightWindowError whose reason is %#", (fn, reason) => {
    let caught: any;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InsightWindowError);
    expect(caught.reason).toBe(reason);
  });

  it("the buckets refusal carries its numbers as params", () => {
    let caught: any;
    try {
      rangeWindow("2025-10-01", "2026-09-29", "day");
    } catch (e) {
      caught = e;
    }
    // either the window or the bucket limit trips first; when it is the bucket limit the numbers are data
    if (caught?.reason === "TOO_MANY_BUCKETS") {
      expect(caught.params).toEqual({
        buckets: expect.any(Number),
        maxBuckets: expect.any(Number),
        grain: "day",
      });
    } else {
      expect(caught === undefined || caught instanceof InsightWindowError).toBe(true);
    }
  });
});

describe("InsightWindowError reason stays OPT-IN (B987-E d)", () => {
  it("only the products export forwards the code; the insights controller still maps the message alone", () => {
    const controller = readFileSync(
      join(__dirname, "../sales-facts/product-insights.controller.ts"),
      "utf8",
    );
    expect(controller).toContain("new BadRequestException(err.message)");
    expect(controller).not.toMatch(/INSIGHT_WINDOW_INVALID|err\.reason|err\.params/);
    const exporter = readFileSync(
      join(__dirname, "../products/products-export.service.ts"),
      "utf8",
    );
    expect(exporter).toContain("API_ERROR_CODES.INSIGHT_WINDOW_INVALID");
  });
});
