import {
  annualPrice,
  annualEffectivePerMo,
  annualSaving,
  cyclePrice,
  prorateDaily,
  daysBetween,
} from "./billing-math";

describe("billing-math — subscription money (regression lock)", () => {
  describe("annualPrice = monthly × 10 (exact)", () => {
    it.each([
      [99, 990],
      [249, 2490],
      [499, 4990],
      [12, 120],
      [19, 190],
    ])("monthly $%d → annual $%d", (m, y) => {
      expect(annualPrice(m)).toBe(y);
    });
  });

  describe("annualEffectivePerMo = whole-dollar round(monthly×10/12) — matches pricing.html", () => {
    it.each([
      [99, 83],
      [249, 208],
      [499, 416], // 415.83 rounds UP to 416, never floors to 415
    ])("monthly $%d → $%d/mo billed annually", (m, eff) => {
      expect(annualEffectivePerMo(m)).toBe(eff);
    });
  });

  it("annualSaving is exactly two months", () => {
    expect(annualSaving(99)).toBe(198);
    expect(annualSaving(499)).toBe(998);
  });

  it("cyclePrice picks monthly vs annual", () => {
    expect(cyclePrice(249, "MONTHLY")).toBe(249);
    expect(cyclePrice(249, "ANNUAL")).toBe(2490);
  });

  describe("prorateDaily (30-day cycle, 16 days remaining) — spec figures", () => {
    it.each([
      [12, 6.4], // SEAT_EXTRA
      [15, 8.0], // ROUTE_EXTRA
      [39, 20.8], // REGULATED_ITEMS (RF-2026-0208)
      [49, 26.13], // BUYER_PORTAL
    ])("monthly $%d → prorated $%s", (m, expected) => {
      expect(prorateDaily(m, 16, 30)).toBe(expected);
    });

    it("clamps daysRemaining to [0, daysInCycle]", () => {
      expect(prorateDaily(30, 40, 30)).toBe(30); // full month, never more
      expect(prorateDaily(30, -5, 30)).toBe(0); // never negative
    });

    it("returns 0 for a non-positive cycle length", () => {
      expect(prorateDaily(30, 10, 0)).toBe(0);
    });

    it("full remaining cycle equals the full monthly price", () => {
      expect(prorateDaily(99, 30, 30)).toBe(99);
    });
  });

  describe("daysBetween (UTC, ceil, never negative)", () => {
    it("counts remaining days", () => {
      expect(daysBetween(new Date("2026-07-15T00:00:00Z"), new Date("2026-07-31T00:00:00Z"))).toBe(
        16,
      );
    });
    it("never negative", () => {
      expect(daysBetween(new Date("2026-07-31T00:00:00Z"), new Date("2026-07-15T00:00:00Z"))).toBe(
        0,
      );
    });
  });
});
