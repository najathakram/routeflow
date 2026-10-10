import {
  axisLabel,
  fmtDemandMoney,
  chartBars,
  DEMAND_RANGE_OPTIONS,
  monthYear,
  rangeNoun,
  suggestRange,
  tickStep,
  tipLabel,
} from "../lib/demand-chart-logic";
import type { DemandBucket } from "@routeflow/types";

const b = (date: string, units: number, revenue = 0): DemandBucket => ({ date, units, revenue });

describe("chartBars", () => {
  it("scales heights proportionally to the max", () => {
    const r = chartBars(
      [b("2026-01-01", 10), b("2026-01-02", 5), b("2026-01-03", 0)],
      "units",
      "day",
    );
    expect(r.max).toBe(10);
    expect(r.bars.map((x) => x.heightPct)).toEqual([100, 50, 0]);
  });
  it("all-zero series has max 0 and no NaN heights", () => {
    const r = chartBars([b("2026-01-01", 0), b("2026-01-02", 0)], "units", "day");
    expect(r.max).toBe(0);
    expect(r.bars.map((x) => x.heightPct)).toEqual([0, 0]);
  });
  it("single point fills the chart", () => {
    const r = chartBars([b("2026-03-09", 7)], "units", "week");
    expect(r.bars).toHaveLength(1);
    expect(r.bars[0].heightPct).toBe(100);
  });
  it("empty series is empty", () => {
    expect(chartBars([], "units", "day")).toEqual({ max: 0, bars: [] });
  });
  it("keeps a tiny non-zero bar visible (min 2%)", () => {
    const r = chartBars([b("2026-01-01", 1), b("2026-01-02", 10000)], "units", "day");
    expect(r.bars[0].heightPct).toBe(2);
  });
  it("reads revenue when metric is revenue", () => {
    const r = chartBars([b("2026-01-01", 1, 30), b("2026-01-02", 9, 60)], "revenue", "day");
    expect(r.max).toBe(60);
    expect(r.bars.map((x) => x.value)).toEqual([30, 60]);
    expect(r.bars.map((x) => x.heightPct)).toEqual([50, 100]);
  });
  it("labels every nth bar for long series and always the first", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      b(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, i),
    );
    const r = chartBars(many, "units", "month");
    const shown = r.bars.filter((x) => x.showAxis).length;
    expect(r.bars[0].showAxis).toBe(true);
    expect(shown).toBe(10);
  });
  it("labels every bar up to 12 points", () => {
    const r = chartBars(
      Array.from({ length: 12 }, (_, i) => b(`2026-01-0${(i % 9) + 1}`, 1)),
      "units",
      "month",
    );
    expect(r.bars.every((x) => x.showAxis)).toBe(true);
  });
});

describe("tickStep", () => {
  it("is 1 up to 12 buckets, then targets about 10 labels", () => {
    expect(tickStep(1)).toBe(1);
    expect(tickStep(12)).toBe(1);
    expect(tickStep(13)).toBe(2);
    expect(tickStep(30)).toBe(3);
    expect(tickStep(60)).toBe(6);
  });
});

describe("labels", () => {
  it("formats day/week as m/d and month as Mon 'yy without Date parsing", () => {
    expect(axisLabel("2026-03-09", "day")).toBe("3/9");
    expect(axisLabel("2026-03-09", "week")).toBe("3/9");
    expect(axisLabel("2026-03-01", "month")).toBe("Mar '26");
  });
  it("formats tips per granularity", () => {
    expect(tipLabel("2026-03-09", "day")).toBe("Mar 9, 2026");
    expect(tipLabel("2026-03-09", "week")).toBe("Week of Mar 9");
    expect(tipLabel("2026-03-01", "month")).toBe("Mar 2026");
    expect(monthYear("2025-12-14")).toBe("Dec 2025");
  });
});

describe("ranges", () => {
  it("exposes the four ranges in order with nouns", () => {
    expect(DEMAND_RANGE_OPTIONS.map((o) => o.value)).toEqual(["30d", "6m", "1y", "5y"]);
    expect(DEMAND_RANGE_OPTIONS.map((o) => o.label)).toEqual(["30D", "6M", "1Y", "5Y"]);
    expect(rangeNoun("30d")).toBe("30 days");
    expect(rangeNoun("1y")).toBe("year");
  });
  it("suggests the smallest range guaranteed to reach the last sale", () => {
    const now = Date.UTC(2026, 8, 25);
    expect(suggestRange("2026-08-30", "30d", now)).toBeNull(); // already inside 30d
    expect(suggestRange("2026-06-01", "30d", now)).toBe("6m");
    expect(suggestRange("2026-01-01", "6m", now)).toBe("1y");
    expect(suggestRange("2023-01-01", "1y", now)).toBe("5y");
    expect(suggestRange(null, "30d", now)).toBeNull();
  });
});

describe("fmtDemandMoney — web parity", () => {
  it("groups thousands like web's DemandCard", () => {
    expect(fmtDemandMoney(12345.67)).toBe("$12,345.67");
    expect(fmtDemandMoney(0)).toBe("$0.00");
    expect(fmtDemandMoney(Number.NaN)).toBe("$0.00");
  });
});
