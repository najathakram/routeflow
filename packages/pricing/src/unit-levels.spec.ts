import { resolveUnitPrice } from "./unit-levels";

const emptyLevel = {
  factorToBase: 1,
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
};

describe("resolveUnitPrice", () => {
  it("derives a Piece level's price by straight factor ratio off the pack (12/box, box 12.00 -> piece 1.00)", () => {
    const price = resolveUnitPrice({
      packPrice: 12.0,
      packFactor: 12,
      tierPackPrice: 12.0,
      level: { ...emptyLevel, factorToBase: 1 },
      tier: 1,
    });
    expect(price).toBe(1.0);
  });

  it("returns the level's own explicit price at the requested tier untouched", () => {
    const price = resolveUnitPrice({
      packPrice: 42.0,
      packFactor: 24,
      tierPackPrice: 38.0,
      level: { ...emptyLevel, factorToBase: 288, price: 480.0, priceTier2: 440.0 },
      tier: 2,
    });
    expect(price).toBe(440.0);
  });

  it("derives an unset tier proportionally to the pack's own tier ladder when tier 1 is explicit (case 480.00 tier1, pack 42.00/38.00 -> tier2 case)", () => {
    const price = resolveUnitPrice({
      packPrice: 42.0,
      packFactor: 24,
      tierPackPrice: 38.0,
      level: { ...emptyLevel, factorToBase: 288, price: 480.0 },
      tier: 2,
    });
    expect(price).toBe(Math.round(((480 * 38) / 42) * 100) / 100);
  });

  it("derives every tier by factor ratio when the level has no explicit price at all", () => {
    const price = resolveUnitPrice({
      packPrice: 42.0,
      packFactor: 24,
      tierPackPrice: 38.0,
      level: { ...emptyLevel, factorToBase: 288 },
      tier: 2,
    });
    expect(price).toBe(Math.round(((38 * 288) / 24) * 100) / 100);
  });

  it("rounds exactly once, at the end", () => {
    const price = resolveUnitPrice({
      packPrice: 10,
      packFactor: 3,
      tierPackPrice: 10,
      level: { ...emptyLevel, factorToBase: 7 },
      tier: 1,
    });
    // 10 * 7 / 3 = 23.333...
    expect(price).toBe(23.33);
  });
});
