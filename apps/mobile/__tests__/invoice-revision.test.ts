import { overpaidText, revisedBadgeText } from "../lib/invoice-revision";

describe("revisedBadgeText", () => {
  it("reads the day in the business's zone, not the device's", () => {
    const at = "2026-10-06T03:30:00.000Z";
    expect(revisedBadgeText(at, "America/Los_Angeles")).toBe("Revised Oct 5, 2026");
    expect(revisedBadgeText(at, "Asia/Tokyo")).toBe("Revised Oct 6, 2026");
  });
  it("falls back to UTC for an invalid zone instead of throwing", () => {
    expect(revisedBadgeText("2026-10-06T03:30:00.000Z", "Not/AZone")).toBe("Revised Oct 6, 2026");
  });
  it("formats revisedAt as 'Revised {date}'", () => {
    expect(revisedBadgeText("2026-10-05T15:30:00.000Z")).toMatch(/^Revised \w{3} \d{1,2}, 2026$/);
  });
  it.each([undefined, null, "", "not-a-date"])("is null for %p", (v) => {
    expect(revisedBadgeText(v as never)).toBeNull();
  });
});

describe("overpaidText", () => {
  it("shows the rounded amount only when overpaid", () => {
    expect(overpaidText(12.5)).toBe("Overpaid by $12.50");
    expect(overpaidText(0.1 + 0.2)).toBe("Overpaid by $0.30");
  });
  it.each([undefined, null, 0, -3, NaN, 0.004])("is null for %p", (v) => {
    expect(overpaidText(v as never)).toBeNull();
  });
});
