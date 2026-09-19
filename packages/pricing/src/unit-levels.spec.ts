import { getTierPrice } from "./tier-pricing";
import {
  UnknownUnitError,
  fromBaseQty,
  resolveLadderLevel,
  resolveLevelPrice,
  resolveUnitPrice,
  toBaseQty,
  type LadderProduct,
  type LadderUnit,
} from "./unit-levels";

const emptyLevel = {
  factorToBase: 1,
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
};

describe("resolveLevelPrice", () => {
  it("derives a Piece level's price by straight factor ratio off the pack (12/box, box 12.00 -> piece 1.00)", () => {
    const price = resolveLevelPrice({
      packPrice: 12.0,
      packFactor: 12,
      tierPackPrice: 12.0,
      level: { ...emptyLevel, factorToBase: 1 },
      tier: 1,
    });
    expect(price).toBe(1.0);
  });

  it("returns the level's own explicit price at the requested tier untouched", () => {
    const price = resolveLevelPrice({
      packPrice: 42.0,
      packFactor: 24,
      tierPackPrice: 38.0,
      level: { ...emptyLevel, factorToBase: 288, price: 480.0, priceTier2: 440.0 },
      tier: 2,
    });
    expect(price).toBe(440.0);
  });

  it("derives an unset tier proportionally to the pack's own tier ladder when tier 1 is explicit (case 480.00 tier1, pack 42.00/38.00 -> tier2 case)", () => {
    const price = resolveLevelPrice({
      packPrice: 42.0,
      packFactor: 24,
      tierPackPrice: 38.0,
      level: { ...emptyLevel, factorToBase: 288, price: 480.0 },
      tier: 2,
    });
    expect(price).toBe(Math.round(((480 * 38) / 42) * 100) / 100);
  });

  it("derives every tier by factor ratio when the level has no explicit price at all", () => {
    const price = resolveLevelPrice({
      packPrice: 42.0,
      packFactor: 24,
      tierPackPrice: 38.0,
      level: { ...emptyLevel, factorToBase: 288 },
      tier: 2,
    });
    expect(price).toBe(Math.round(((38 * 288) / 24) * 100) / 100);
  });

  it("rounds exactly once, at the end", () => {
    const price = resolveLevelPrice({
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

// ─── The ladder ───────────────────────────────────────────────────────────────

const noPrices = {
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
};
// 24-pack at 42.00 (tier 2 = 38.00), sold also by the Case (288 pcs) and the Pallet (5760 pcs).
const product: LadderProduct = {
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: 42,
  priceTier2: 38,
  priceTier3: 0,
  priceTier4: 0,
  priceTier5: 0,
};
const caseRow: LadderUnit = {
  ...noPrices,
  label: "Case",
  factorToBase: 288,
  price: 480,
  priceTier2: 440,
};
const palletRow: LadderUnit = { ...noPrices, label: "Pallet", factorToBase: 5760 };
const units = [caseRow, palletRow];

describe("resolveUnitPrice (ladder)", () => {
  it("an absent / blank unit label is the pack — price equals getTierPrice at every tier (today's behaviour)", () => {
    for (const tier of [1, 2, 3, 4, 5]) {
      expect(resolveUnitPrice(product, units, undefined, tier)).toBe(getTierPrice(product, tier));
      expect(resolveUnitPrice(product, units, "  ", tier)).toBe(getTierPrice(product, tier));
    }
  });

  it("the pack's own label resolves to the pack, case-insensitively", () => {
    expect(resolveUnitPrice(product, units, "box", 1)).toBe(42);
  });

  it("factor 1 is the base: Piece derives pack price / pack factor when no explicit row exists", () => {
    expect(resolveUnitPrice(product, units, "Piece", 1)).toBe(1.75);
    expect(resolveUnitPrice(product, units, "Piece", 2)).toBe(1.58); // 38 / 24 = 1.5833
  });

  it("an explicit Piece row (factor 1) prices the piece and wins over derivation", () => {
    const pieceRow: LadderUnit = { ...noPrices, label: "Piece", factorToBase: 1, price: 2 };
    expect(resolveUnitPrice(product, [pieceRow], "Piece", 1)).toBe(2);
  });

  it("a level's explicit price wins at the requested tier", () => {
    expect(resolveUnitPrice(product, units, "Case", 1)).toBe(480);
    expect(resolveUnitPrice(product, units, "Case", 2)).toBe(440);
  });

  it("an unset tier on an explicit-price level follows the pack's own tier ladder", () => {
    const c: LadderUnit = { ...noPrices, label: "Case", factorToBase: 288, price: 480 };
    expect(resolveUnitPrice(product, [c], "Case", 2)).toBe(
      Math.round(((480 * 38) / 42) * 100) / 100,
    );
  });

  it("a level with no explicit price derives from the base price × factor ÷ pack factor", () => {
    expect(resolveUnitPrice(product, units, "Pallet", 1)).toBe(42 * 240); // 5760 / 24
  });

  it("tier fallback matches getTierPrice: a 0 tier on the pack falls back to the list price", () => {
    // pack tier 3 is 0 → getTierPrice falls back to 42 → Pallet derives from 42, not 0.
    expect(resolveUnitPrice(product, units, "Pallet", 3)).toBe(42 * 240);
  });

  it("an out-of-range tier index is tier 1", () => {
    expect(resolveUnitPrice(product, units, "Case", 9)).toBe(480);
    expect(resolveUnitPrice(product, units, "Case", 0)).toBe(480);
  });

  it("matches labels exactly first, then case-insensitively", () => {
    const upper: LadderUnit = { ...noPrices, label: "CASE", factorToBase: 100, price: 1 };
    expect(resolveUnitPrice(product, [caseRow, upper], "CASE", 1)).toBe(1);
    expect(resolveUnitPrice(product, [caseRow, upper], "case", 1)).toBe(480); // first ci match
  });

  it("an unknown label throws UnknownUnitError (callers map to 400)", () => {
    expect(() => resolveUnitPrice(product, units, "Truckload", 1)).toThrow(UnknownUnitError);
  });

  it("a non-boxed product (unitsPerBox null) treats the pack as factor 1", () => {
    const loose: LadderProduct = { unit: "Each", unitsPerBox: null, pricePerUnit: 3 };
    const dozen: LadderUnit = { ...noPrices, label: "Dozen", factorToBase: 12 };
    expect(resolveUnitPrice(loose, [dozen], "Dozen", 1)).toBe(36);
    expect(resolveLadderLevel(loose, [dozen], undefined).factorToBase).toBe(1);
  });
});

describe("toBaseQty / fromBaseQty", () => {
  it("toBaseQty multiplies whole units by the factor and floors bad input to 0", () => {
    expect(toBaseQty(3, 288)).toBe(864);
    expect(toBaseQty(2.9, 24)).toBe(48);
    expect(toBaseQty(-1, 24)).toBe(0);
    expect(toBaseQty(5, 0)).toBe(0);
    expect(toBaseQty(Number.NaN, 24)).toBe(0);
  });

  it("splits largest level first; the remainder lands on the smallest level (Piece)", () => {
    expect(fromBaseQty(288 * 2 + 24 * 3 + 5, product, units)).toEqual([
      { label: "Case", factorToBase: 288, qty: 2 },
      { label: "Box", factorToBase: 24, qty: 3 },
      { label: "Piece", factorToBase: 1, qty: 5 },
    ]);
  });

  it("never drops a remainder: Σ qty × factor === baseQty for every quantity", () => {
    for (let base = 0; base <= 6000; base += 7) {
      const parts = fromBaseQty(base, product, units);
      expect(parts.reduce((n, p) => n + p.qty * p.factorToBase, 0)).toBe(base);
    }
  });

  it("with no levels above the pack it reproduces normalizeBoxesPieces", () => {
    expect(fromBaseQty(50, product, [])).toEqual([
      { label: "Box", factorToBase: 24, qty: 2 },
      { label: "Piece", factorToBase: 1, qty: 2 },
    ]);
  });

  it("zero / negative / fractional bases are safe", () => {
    expect(fromBaseQty(0, product, units)).toEqual([]);
    expect(fromBaseQty(-5, product, units)).toEqual([]);
    expect(fromBaseQty(1.9, product, units)).toEqual([{ label: "Piece", factorToBase: 1, qty: 1 }]);
  });

  it("round-trips: toBaseQty of each part sums back to the input", () => {
    const parts = fromBaseQty(6000, product, units);
    expect(parts.reduce((n, p) => n + toBaseQty(p.qty, p.factorToBase), 0)).toBe(6000);
  });
});
