import {
  SUGGESTED_TIME_ZONE,
  canonicalTimeZone,
  isValidTimeZone,
  listTimeZones,
} from "./timezones";

describe("isValidTimeZone / canonicalTimeZone", () => {
  it.each(["UTC", "America/Argentina/Buenos_Aires", "Etc/GMT+5", SUGGESTED_TIME_ZONE])(
    "accepts %s",
    (z) => expect(isValidTimeZone(z)).toBe(true),
  );
  it.each([" America/Chicago", "+05:00", "", "EST5EDT x", "Mars/Olympus"])("rejects %j", (z) =>
    expect(isValidTimeZone(z)).toBe(false),
  );
  it("normalises case to the canonical spelling", () => {
    expect(canonicalTimeZone("america/chicago")).toBe("America/Chicago");
    expect(canonicalTimeZone("+05:00")).toBeNull();
  });
});

describe("listTimeZones", () => {
  const intl = Intl as unknown as { supportedValuesOf?: unknown };
  const original = intl.supportedValuesOf;
  afterEach(() => {
    intl.supportedValuesOf = original;
  });
  it("falls back to the built-in list when supportedValuesOf is missing", () => {
    intl.supportedValuesOf = undefined;
    expect(listTimeZones()).toContain("America/New_York");
  });
  it("falls back when supportedValuesOf throws", () => {
    intl.supportedValuesOf = () => {
      throw new RangeError("nope");
    };
    expect(listTimeZones()).toContain("America/Chicago");
  });
  it("uses the runtime list when available", () => {
    intl.supportedValuesOf = () => ["Pacific/Auckland"];
    expect(listTimeZones()).toEqual(["Pacific/Auckland"]);
  });
});
