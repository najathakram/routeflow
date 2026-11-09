import {
  ORDER_DATE_MAX_FUTURE_DAYS,
  ORDER_DATE_MAX_PAST_YEARS,
  addDays,
  daysBetween,
  isRealDay,
  orderDateDrift,
  orderDateRange,
  tenantDayOf,
} from "./order-date";

describe("order date caps and drift (W-1188)", () => {
  it("names the owner's two typo guards once", () => {
    expect(ORDER_DATE_MAX_PAST_YEARS).toBe(2);
    expect(ORDER_DATE_MAX_FUTURE_DAYS).toBe(366);
  });

  it("reads the tenant day, not the UTC day (Chicago evening)", () => {
    const now = new Date("2026-11-10T02:00:00.000Z"); // Mon 20:00 CST
    expect(tenantDayOf(now, "America/Chicago")).toBe("2026-11-09");
    expect(tenantDayOf(now, null)).toBe("2026-11-10");
    expect(tenantDayOf(now, "Not/AZone")).toBe("2026-11-10"); // unknown reads UTC
  });

  it("OFFICE ends today; COUNTER reaches 366 days ahead; both floor at two years inclusive", () => {
    expect(orderDateRange("2026-11-09", "OFFICE")).toEqual({
      min: "2024-11-09",
      max: "2026-11-09",
    });
    expect(orderDateRange("2026-11-09", "COUNTER")).toEqual({
      min: "2024-11-09",
      max: "2027-11-10",
    });
  });

  it("a Feb 29 today floors on Feb 28 two years back", () => {
    expect(orderDateRange("2028-02-29", "OFFICE").min).toBe("2026-02-28");
  });

  it("day arithmetic", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(daysBetween("2026-11-09", "2026-11-06")).toBe(-3);
    expect(isRealDay("2026-02-31")).toBe(false);
    expect(isRealDay("2026-02-28")).toBe(true);
  });

  it("drift: back, forward, and not dated", () => {
    const entered = new Date("2026-11-09T22:12:00.000Z"); // 16:12 Chicago, the 9th
    expect(
      orderDateDrift(new Date("2026-11-06T00:00:00.000Z"), entered, "America/Chicago"),
    ).toEqual({
      day: "2026-11-06",
      enteredDay: "2026-11-09",
      direction: "BACK",
      days: -3,
    });
    expect(orderDateDrift("2026-11-16T00:00:00.000Z", entered, "America/Chicago")).toMatchObject({
      direction: "FORWARD",
      days: 7,
    });
    expect(orderDateDrift("2026-11-09T00:00:00.000Z", entered, "America/Chicago")).toBeNull();
    expect(orderDateDrift(null, entered, "America/Chicago")).toBeNull();
  });
});
