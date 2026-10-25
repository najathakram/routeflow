import { priceInUnit, pricePerBaseUnit } from "./unit-price-convert";

// SA-954 D3 / F6: a price re-expressed in another unit is ONE conversion pair. The per-base price stays unrounded
// until the very end, so a month that mixes units averages the real prices, not rounded ones.
describe("pricePerBaseUnit / priceInUnit", () => {
  it("pricePerBaseUnit divides by the pieces per unit and never rounds", () => {
    expect(pricePerBaseUnit(25, 12)).toBeCloseTo(2.0833333333, 10);
    expect(pricePerBaseUnit(2.15, 1)).toBe(2.15);
  });

  it.each([null, 0, -12, Number.NaN, Number.POSITIVE_INFINITY])(
    "an unknown or unusable pack (%p) is null, never guessed",
    (pack) => {
      expect(pricePerBaseUnit(25, pack as number | null)).toBeNull();
    },
  );

  it("a non-finite price is null", () => {
    expect(pricePerBaseUnit(Number.NaN, 12)).toBeNull();
  });

  it("priceInUnit is the only rounding: perBase x pieces through roundMoney", () => {
    expect(priceInUnit(2.0927083333, 12)).toBe(25.11);
    expect(priceInUnit(2.0927083333, 1)).toBe(2.09);
    expect(priceInUnit(2.0927083333, 48)).toBe(100.45);
  });

  it("F6 (observed): one month, four lines in four units. Line 3 is 25.11 per Box of 12, never the round-first 25.08", () => {
    // this customer: Box of 12 @ 25.00; others: Box of 24 @ 46.80, Piece @ 2.15, Case of 48 @ 105.00
    const lines: Array<[number, number]> = [
      [25.0, 12],
      [46.8, 24],
      [2.15, 1],
      [105.0, 48],
    ];
    const perBase = lines.map(([p, k]) => pricePerBaseUnit(p, k) as number);
    const mean = perBase.reduce((s, v) => s + v, 0) / perBase.length;
    expect(mean).toBeCloseTo(2.0927083333, 9);
    expect(priceInUnit(mean, 12)).toBe(25.11);
    expect(priceInUnit(mean, 1)).toBe(2.09);
    expect(priceInUnit(mean, 48)).toBe(100.45);
    // the WRONG value: round the per-piece figure (2.09), then scale it back up to the box
    expect(Math.round(Math.round(mean * 100) * 12) / 100).toBe(25.08);
    expect(priceInUnit(mean, 12)).not.toBe(25.08);
  });

  it("invariant: when every line is in the plot unit, the converted mean equals the plain mean", () => {
    const prices = [24.0, 24.5, 24.1];
    const plain = Math.round(((prices[0] + prices[1] + prices[2]) / 3) * 100) / 100;
    const perBase = prices.map((p) => pricePerBaseUnit(p, 12) as number);
    const mean = perBase.reduce((s, v) => s + v, 0) / perBase.length;
    expect(priceInUnit(mean, 12)).toBe(plain);
    expect(plain).toBe(24.2);
  });

  it("pack to piece equals the old inline expression (the references' inUnit): 30 / 12 = 2.50", () => {
    expect(priceInUnit(pricePerBaseUnit(30, 12) as number, 1)).toBe(2.5);
  });
});
