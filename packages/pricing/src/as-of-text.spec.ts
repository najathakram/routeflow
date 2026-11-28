import { asOfText } from "./as-of-text";

/** SA-1209 D3: "Nov 21, 2026, 4:46 PM CST". The clock is an argument, never read (L-353). */
describe("asOfText", () => {
  it("prints date, time and the short zone name in the tenant's zone", () => {
    expect(asOfText(new Date("2026-11-21T22:46:00.000Z"), "America/Chicago")).toBe(
      "Nov 21, 2026, 4:46 PM CST",
    );
  });

  it("uses the tenant's day, not the UTC day, across midnight UTC", () => {
    expect(asOfText("2026-11-22T05:30:00.000Z", "America/Chicago")).toBe(
      "Nov 21, 2026, 11:30 PM CST",
    );
  });

  it("names daylight time in summer", () => {
    expect(asOfText("2026-07-01T15:00:00.000Z", "America/Chicago")).toBe(
      "Jul 1, 2026, 10:00 AM CDT",
    );
  });

  it("never leaves the zone out, even where Intl has no abbreviation", () => {
    expect(asOfText(new Date("2026-11-21T22:46:00.000Z"), "Asia/Kolkata")).toBe(
      "Nov 22, 2026, 4:16 AM GMT+5:30",
    );
  });

  it("prints UTC as UTC", () => {
    expect(asOfText("2026-11-21T22:46:00.000Z", "UTC")).toBe("Nov 21, 2026, 10:46 PM UTC");
  });
});
