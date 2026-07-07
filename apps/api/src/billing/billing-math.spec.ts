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
      [59, 590],
      [149, 1490],
      [349, 3490],
      [12, 120],
      [19, 190],
    ])("monthly $%d → annual $%d", (m, y) => {
      expect(annualPrice(m)).toBe(y);
    });
  });

  describe("annualEffectivePerMo = whole-dollar round(monthly×10/12) — matches pricing.html", () => {
    it.each([
      [59, 49],
      [149, 124],
      [349, 291], // 290.83 rounds UP to 291, never floors to 290
    ])("monthly $%d → $%d/mo billed annually", (m, eff) => {
      expect(annualEffectivePerMo(m)).toBe(eff);
    });
  });

  it("annualSaving is exactly two months", () => {
    expect(annualSaving(59)).toBe(118);
    expect(annualSaving(349)).toBe(698);
  });

  it("cyclePrice picks monthly vs annual", () => {
    expect(cyclePrice(149, "MONTHLY")).toBe(149);
    expect(cyclePrice(149, "ANNUAL")).toBe(1490);
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
      expect(prorateDaily(59, 30, 30)).toBe(59);
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
