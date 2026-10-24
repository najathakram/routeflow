import { givenPaidInstant, keptPaidInstantOf, paidInstantOf } from "./paid-instant";

// SA-943 PR-A: the write-seam helper for a date-only paid / settled / received date.
const CHI = "America/Chicago";
const at2000CdtOct24 = new Date("2026-10-25T01:00:00.000Z"); // 20:00 CDT on 10-24

describe("paidInstantOf (SA-943)", () => {
  it("a date-only tenant-local TODAY is the real instant now, not 00:00Z", () => {
    expect(paidInstantOf("2026-10-24", CHI, at2000CdtOct24)).toEqual(at2000CdtOct24);
    expect(givenPaidInstant("2026-10-24", CHI, at2000CdtOct24)).toBeNull(); // the caller's own clock
  });

  it("a past date-only day is the tenant-local start of that day (10-01 CDT = 05:00Z)", () => {
    expect(paidInstantOf("2026-10-01", CHI, at2000CdtOct24).toISOString()).toBe(
      "2026-10-01T05:00:00.000Z",
    );
    expect(paidInstantOf("2026-01-15", CHI, at2000CdtOct24).toISOString()).toBe(
      "2026-01-15T06:00:00.000Z", // CST
    );
  });

  it("the UTC day after 19:00 CDT is TOMORROW in Chicago: a future day's local start, never now", () => {
    expect(paidInstantOf("2026-10-25", CHI, at2000CdtOct24).toISOString()).toBe(
      "2026-10-25T05:00:00.000Z",
    );
  });

  it("an east-of-UTC tenant: today is now, a past day is its local midnight", () => {
    const tokyoNoon = new Date("2026-10-24T03:00:00.000Z");
    expect(paidInstantOf("2026-10-24", "Asia/Tokyo", tokyoNoon)).toEqual(tokyoNoon);
    expect(paidInstantOf("2026-10-20", "Asia/Tokyo", tokyoNoon).toISOString()).toBe(
      "2026-10-19T15:00:00.000Z",
    );
  });

  it("a null zone is the UTC fallback", () => {
    expect(paidInstantOf("2026-10-01", null, at2000CdtOct24).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(paidInstantOf("2026-10-25", null, at2000CdtOct24)).toEqual(at2000CdtOct24);
  });

  it("a full ISO instant is stored as given; a blank is now", () => {
    const iso = "2026-10-24T14:30:00.000Z";
    expect(paidInstantOf(iso, CHI, at2000CdtOct24).toISOString()).toBe(iso);
    expect(paidInstantOf(new Date(iso), CHI, at2000CdtOct24).toISOString()).toBe(iso);
    expect(paidInstantOf(undefined, CHI, at2000CdtOct24)).toEqual(at2000CdtOct24);
    expect(paidInstantOf(null, CHI, at2000CdtOct24)).toEqual(at2000CdtOct24);
    expect(paidInstantOf("", CHI, at2000CdtOct24)).toEqual(at2000CdtOct24);
  });

  it("a date-only value that names no real day is a 400, never a rolled-over date", () => {
    expect(() => paidInstantOf("2026-02-30", CHI, at2000CdtOct24, "settledAt")).toThrow(
      "settledAt must be a real calendar date",
    );
  });
});

describe("keptPaidInstantOf (SA-943 MUST 2: an edit never re-stamps)", () => {
  const stored = new Date("2026-10-22T02:00:00.000Z"); // 21:00 CDT on 10-21

  it("the stored instant's tenant-local date resent unchanged keeps the stored instant", () => {
    expect(keptPaidInstantOf("2026-10-21", stored, CHI, at2000CdtOct24)).toBe(stored);
  });

  it("a different date-only day moves to that day's local start", () => {
    expect(keptPaidInstantOf("2026-10-20", stored, CHI, at2000CdtOct24).toISOString()).toBe(
      "2026-10-20T05:00:00.000Z",
    );
  });

  it("an edit to today stores now; a full ISO instant is taken as given", () => {
    expect(keptPaidInstantOf("2026-10-24", stored, CHI, at2000CdtOct24)).toEqual(at2000CdtOct24);
    expect(
      keptPaidInstantOf("2026-10-21T15:00:00.000Z", stored, CHI, at2000CdtOct24).toISOString(),
    ).toBe("2026-10-21T15:00:00.000Z");
  });

  it("no stored instant (a cleared settledAt): plain paidInstantOf", () => {
    expect(keptPaidInstantOf("2026-10-21", null, CHI, at2000CdtOct24).toISOString()).toBe(
      "2026-10-21T05:00:00.000Z",
    );
  });
});
