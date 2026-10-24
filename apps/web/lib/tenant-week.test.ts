import { startOfTenantWeek } from "./tenant-week";

const iso = (d: Date) => d.toISOString();

describe("startOfTenantWeek", () => {
  const LA = "America/Los_Angeles";
  it("Saturday 23:59 local belongs to the week that began the previous Sunday", () => {
    // Sat 2026-10-10 23:59 PDT (UTC-7) = 2026-10-11T06:59Z
    expect(iso(startOfTenantWeek(new Date("2026-10-11T06:59:00Z"), LA))).toBe(
      "2026-10-04T07:00:00.000Z",
    );
  });
  it("Sunday 00:00 local starts a new week", () => {
    expect(iso(startOfTenantWeek(new Date("2026-10-11T07:00:00Z"), LA))).toBe(
      "2026-10-11T07:00:00.000Z",
    );
  });
  it("works for a + zone (Asia/Tokyo)", () => {
    // Sat 2026-10-10 23:59 JST = 14:59Z; Sun 00:00 JST = 15:00Z
    expect(iso(startOfTenantWeek(new Date("2026-10-10T14:59:00Z"), "Asia/Tokyo"))).toBe(
      "2026-10-03T15:00:00.000Z",
    );
    expect(iso(startOfTenantWeek(new Date("2026-10-10T15:00:00Z"), "Asia/Tokyo"))).toBe(
      "2026-10-10T15:00:00.000Z",
    );
  });
  it("is DST-safe: week containing the fall-back change (2026-11-01 LA)", () => {
    // Wed 2026-11-04 12:00 PST; Sunday 2026-11-01 00:00 PDT = 07:00Z
    expect(iso(startOfTenantWeek(new Date("2026-11-04T20:00:00Z"), LA))).toBe(
      "2026-11-01T07:00:00.000Z",
    );
    // Sat 2026-11-07 is in the week starting Sun 11-01; Sun 11-08 00:00 PST = 08:00Z
    expect(iso(startOfTenantWeek(new Date("2026-11-08T08:00:00Z"), LA))).toBe(
      "2026-11-08T08:00:00.000Z",
    );
  });
  it("is DST-safe: week crossing the spring-forward change (2026-03-08 LA)", () => {
    // Sunday 03-08 00:00 PST = 08:00Z; Tue 03-10 is PDT
    expect(iso(startOfTenantWeek(new Date("2026-03-10T19:00:00Z"), LA))).toBe(
      "2026-03-08T08:00:00.000Z",
    );
    // Sat 03-14 after the change -> still Sun 03-08 00:00 PST
    expect(iso(startOfTenantWeek(new Date("2026-03-14T20:00:00Z"), LA))).toBe(
      "2026-03-08T08:00:00.000Z",
    );
  });
  it("falls back to UTC for an invalid zone", () => {
    // Wed 2026-10-07 UTC -> Sunday 2026-10-04 00:00Z
    expect(iso(startOfTenantWeek(new Date("2026-10-07T10:00:00Z"), "Not/AZone"))).toBe(
      "2026-10-04T00:00:00.000Z",
    );
  });
});
