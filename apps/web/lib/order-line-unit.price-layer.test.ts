import type { CustomerLayerUnit } from "@routeflow/pricing";
import { applyLineUnit, repriceLineFromLayer, type UnitLine } from "./order-line-unit";
import { saleLinePricing } from "./sale-line-pricing";
import type { UnitOption } from "./unit-options";

// S19b slice B (SA-811a R1, SA-813 M2): a unit line reads the customer's layer row for ITS unit. Fixture: pack list $42,
// Case $480 (12 packs); the customer typed $33 on the pack, so the Case is in their shape ($377.14, customer-shape).
const tierPrices = {
  pricePerUnit: "42",
  priceTier2: "40",
  priceTier3: "38",
  priceTier4: null,
  priceTier5: null,
};
const layer: CustomerLayerUnit[] = [
  { ref: "pack", label: null, price: 33, listPrice: 42, source: "customer", aboveList: false },
  {
    ref: "unit-case",
    label: "Case",
    price: 377.14,
    listPrice: 480,
    source: "customer-shape",
    aboveList: false,
  },
];

const packLine = (over: Partial<UnitLine> = {}): UnitLine => ({
  unit: "Bottle",
  qty: 1,
  listPrice: 42,
  unitPrice: 38,
  priceType: "SPECIAL",
  specialPrice: 38,
  tierPrices,
  ...over,
});
const caseOption = {
  kind: "level",
  value: "Case",
  label: "Case",
  price: 456,
  listPrice: 480,
} as unknown as UnitOption;

describe("order-line-unit: the customer's layer (B-4)", () => {
  it("B-4: a Case line (unitLabel Case) reprices to $377.14, list $480", () => {
    const caseLine = applyLineUnit(packLine(), caseOption, { tier: 3 }); // master: the ladder's tier price
    expect(caseLine.unitPrice).toBe(456);
    const r = repriceLineFromLayer(caseLine, { tier: 3, layer });
    expect(r.unitPrice).toBe(377.14);
    expect(r.listPrice).toBe(480);
    expect(r.priceType).toBe("SPECIAL");
    expect(r.specialPrice).toBe(377.14);
    // idempotent: a settled line is returned as-is
    expect(repriceLineFromLayer(r, { tier: 3, layer })).toBe(r);
  });

  it("a pack line takes the typed $33", () => {
    const r = repriceLineFromLayer(packLine(), { tier: 3, layer });
    expect(r.unitPrice).toBe(33);
    expect(r.specialPrice).toBe(33);
  });

  it("an operator's one-time price, a derived-base line and a missing layer are left alone", () => {
    const typed = packLine({ discountedPrice: 30, unitPrice: 30, priceType: "DISCOUNTED" });
    expect(repriceLineFromLayer(typed, { tier: 3, layer })).toBe(typed);
    const plain = packLine();
    expect(repriceLineFromLayer(plain, { tier: 3, layer: undefined })).toBe(plain);
    const derived = packLine({ derivedBase: "base" });
    expect(repriceLineFromLayer(derived, { tier: 3, layer })).toBe(derived);
  });

  it("a Case line with no layer row for it is master's price", () => {
    const caseLine = applyLineUnit(packLine(), caseOption, { tier: 3 });
    const onlyPack = layer.slice(0, 1);
    expect(repriceLineFromLayer(caseLine, { tier: 3, layer: onlyPack })).toBe(caseLine);
  });

  it("back to the pack with a layer restores the customer's $33; without one, the tier price", () => {
    const caseLine = applyLineUnit(packLine(), caseOption, { tier: 3 });
    const back = applyLineUnit(caseLine, { kind: "pack" } as UnitOption, { tier: 3, layer });
    expect(back.unitPrice).toBe(33);
    const backMaster = applyLineUnit(caseLine, { kind: "pack" } as UnitOption, { tier: 3 });
    expect(backMaster.unitPrice).toBe(38);
  });
});

describe("sale-line-pricing: a CustomerLinePrice carries the baseline (B-1/B-3)", () => {
  const product = { pricePerUnit: "42", priceTier3: "38" };
  it("master without a line price", () => {
    expect(saleLinePricing(product, 3)).toEqual({
      tierPrice: 38,
      listPrice: 42,
      isSpecialTier: true,
    });
  });
  it("the layer price is the baseline, list is the layer's list", () => {
    const lp = {
      price: 33,
      listPrice: 42,
      isSpecial: true,
      priceType: "SPECIAL" as const,
      layered: true,
    };
    expect(saleLinePricing(product, 3, lp)).toEqual({
      tierPrice: 33,
      listPrice: 42,
      isSpecialTier: true,
    });
  });
});
