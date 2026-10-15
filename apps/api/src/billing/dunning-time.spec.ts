import { hoursSince, localHourOf, pauseHourReached } from "./dunning-time";

describe("dunning-time (the 03:00 tenant-local pause rule)", () => {
  it("02:59 local does not reach the pause hour, 03:00 does (America/Chicago, CDT = UTC-5)", () => {
    // Oct 31 2026 is still CDT (UTC-5): 07:59Z = 02:59 local, 08:00Z = 03:00 local.
    expect(pauseHourReached(new Date("2026-10-31T07:59:00Z"), "America/Chicago")).toBe(false);
    expect(pauseHourReached(new Date("2026-10-31T08:00:00Z"), "America/Chicago")).toBe(true);
    // 14:00Z = 09:00 local: any later sweep of the local day pauses too
    expect(pauseHourReached(new Date("2026-10-31T14:00:00Z"), "America/Chicago")).toBe(true);
  });

  it("follows the DST change: 02:30 local is a different UTC instant before and after the fall-back", () => {
    // US fall-back is 2026-11-01 02:00 CDT -> 01:00 CST. Oct 31 (CDT, -5): 07:30Z = 02:30 local.
    // Nov 2 (CST, -6): 08:30Z = 02:30 local and 09:00Z = 03:00 local.
    expect(localHourOf(new Date("2026-10-31T07:30:00Z"), "America/Chicago")).toBe(2);
    expect(localHourOf(new Date("2026-11-02T08:30:00Z"), "America/Chicago")).toBe(2);
    expect(pauseHourReached(new Date("2026-11-02T08:59:00Z"), "America/Chicago")).toBe(false);
    expect(pauseHourReached(new Date("2026-11-02T09:00:00Z"), "America/Chicago")).toBe(true);
  });

  it("midnight reads as hour 0, never 24", () => {
    expect(localHourOf(new Date("2026-06-01T00:10:00Z"), "UTC")).toBe(0);
    expect(pauseHourReached(new Date("2026-06-01T00:10:00Z"), "UTC")).toBe(false);
  });

  it("a missing or invalid zone falls back to UTC and never throws", () => {
    const at = new Date("2026-06-01T03:05:00Z");
    expect(localHourOf(at, null)).toBe(3);
    expect(localHourOf(at, undefined)).toBe(3);
    expect(localHourOf(at, "Not/AZone")).toBe(3);
    expect(pauseHourReached(at, "")).toBe(true);
  });

  it("hoursSince keeps fractions and clamps a clock in the future to 0", () => {
    const since = new Date("2026-06-01T00:00:00Z");
    expect(hoursSince(since, new Date("2026-06-08T00:00:00Z"))).toBe(168);
    expect(hoursSince(since, new Date("2026-06-01T01:30:00Z"))).toBe(1.5);
    expect(hoursSince(since, new Date("2026-05-31T00:00:00Z"))).toBe(0);
  });
});
