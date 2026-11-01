import { isZoneUnset } from "./tenant-timezone";

/** SA-1067 Z4: "UTC" is the fallback the API writes when nobody picked a zone, so it is the one value that means "not set yet". */
describe("isZoneUnset", () => {
  it("is true only for UTC", () => {
    expect(isZoneUnset("UTC")).toBe(true);
    expect(isZoneUnset("America/Chicago")).toBe(false);
    expect(isZoneUnset("America/New_York")).toBe(false);
  });

  it("is false while the zone is unknown, so nothing flashes before /settings answers", () => {
    expect(isZoneUnset(undefined)).toBe(false);
    expect(isZoneUnset("")).toBe(false);
  });
});
