import {
  bucketAxisLabel,
  bucketTitle,
  fileToken,
  formatAgo,
  formatDay,
  formatEvery,
  formatMoneyShort,
  formatShare,
  localToday,
  presetFrom,
  priceVsAverage,
} from "./insights-format";

describe("insights-format (#2121)", () => {
  it("formats calendar days without a timezone shift", () => {
    expect(formatDay("2026-09-01")).toBe("Sep 1, 2026");
    expect(bucketAxisLabel("2026-09-01", "month")).toBe("Sep '26");
    expect(bucketAxisLabel("2026-10-01", "quarter")).toBe("Q4 '26");
    expect(bucketAxisLabel("2026-09-07", "week")).toBe("9/7");
    expect(bucketTitle("2026-09-07", "week")).toBe("Week of Sep 7, 2026");
    expect(bucketTitle("2026-04-01", "quarter")).toBe("Q2 2026");
  });

  it("presetFrom: the first day of a trailing N-calendar-month window, across a year boundary", () => {
    expect(presetFrom("2026-09-26", 12)).toBe("2025-10-01");
    expect(presetFrom("2026-02-10", 3)).toBe("2025-12-01");
    expect(presetFrom("2026-01-31", 1)).toBe("2026-01-01");
    expect(presetFrom("2026-09-26", 24)).toBe("2024-10-01");
  });

  it("localToday uses the browser's calendar, zero-padded", () => {
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });

  it("priceVsAverage: signed percentage, ±0.5% counts as the same, missing sides → null", () => {
    expect(priceVsAverage(2.2, 2)).toEqual({ pct: 10, tone: "above", label: "+10.0% vs avg" });
    expect(priceVsAverage(1.5, 2)).toEqual({ pct: -25, tone: "below", label: "-25.0% vs avg" });
    expect(priceVsAverage(2.008, 2)).toEqual({ pct: 0, tone: "same", label: "at average" });
    expect(priceVsAverage(null, 2)).toBeNull();
    expect(priceVsAverage(2, null)).toBeNull();
    expect(priceVsAverage(2, 0)).toBeNull();
  });

  it("short money, shares, cadence and age wording", () => {
    expect(formatMoneyShort(950)).toBe("$950");
    expect(formatMoneyShort(1_234)).toBe("$1.2k");
    expect(formatMoneyShort(-45_600)).toBe("-$46k");
    expect(formatMoneyShort(2_500_000)).toBe("$2.5M");
    expect(formatShare(0.4213)).toBe("42%");
    expect(formatShare(0.052)).toBe("5.2%");
    expect(formatShare(0)).toBe("0%");
    expect(formatEvery(7)).toBe("every 7 days");
    expect(formatEvery(1)).toBe("every 1 day");
    expect(formatEvery(3.5)).toBe("every 3.5 days");
    expect(formatAgo(0)).toBe("today");
    expect(formatAgo(1)).toBe("1 day ago");
  });

  it("fileToken keeps a download name safe", () => {
    expect(fileToken("Acme Deli & Co.")).toBe("Acme-Deli-Co");
    expect(fileToken("***")).toBe("customer");
  });
});
