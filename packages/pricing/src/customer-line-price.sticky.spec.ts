import { customerLinePrice, type CustomerLayerUnit } from "./customer-line-price";
import { effectiveBuyerPrice, isStickyUpsell } from "./pricing";

// SA-1068: the one rule for a remembered price. Billing (the buyer merge, units v2 Customer view) and the till display
// both call `isStickyUpsell`, so the screen cannot drift from the server. Pack list $10, tier 3 column $8.
const product = {
  unit: "Box",
  unitsPerBox: 12,
  pricePerUnit: "10.00",
  priceTier2: null,
  priceTier3: "8.00",
  priceTier4: null,
  priceTier5: null,
};

describe("SA-1068 S7: isStickyUpsell(remembered, listPrice)", () => {
  it.each([
    ["null", null, false],
    ["undefined", undefined, false],
    ["below list", 9.99, false],
    ["equal to list", 10, false],
    ["a cent above list", 10.01, true],
    ["well above list", 15, true],
  ])("%s", (_label, remembered, expected) => {
    expect(isStickyUpsell(remembered as number | null | undefined, 10)).toBe(expected);
  });
});

describe("SA-1068 customerLinePrice with a remembered price", () => {
  it("T1: an above-list remembered price on the pack is the line: MANUAL, not special, list shown as the base", () => {
    const p = customerLinePrice({ product, tier: 1, remembered: 15 });
    expect(p).toMatchObject({
      price: 15,
      listPrice: 10,
      isSpecial: false,
      priceType: "MANUAL",
      layered: false,
    });
  });

  it("T3: a remembered price below or at list changes nothing: the tier price", () => {
    for (const remembered of [9, 10, null, undefined]) {
      expect(customerLinePrice({ product, tier: 3, remembered })).toMatchObject({
        price: 8,
        priceType: "SPECIAL",
      });
    }
  });

  it("T4: a layered pack keeps the layer: the layer row beats the remembered price", () => {
    const layer: CustomerLayerUnit[] = [
      {
        ref: "pack",
        label: null,
        price: 9,
        listPrice: 10,
        source: "customer",
        aboveList: false,
      },
    ];
    expect(customerLinePrice({ product, tier: 1, layer, remembered: 15 })).toMatchObject({
      price: 9,
      layered: true,
    });
  });

  it("a unit line (not the pack) never takes the remembered price", () => {
    expect(
      customerLinePrice({ product, tier: 1, unitLabel: "Piece", tierPrice: 0.83, remembered: 15 }),
    ).toMatchObject({ price: 0.83, priceType: "STANDARD" });
  });

  it("omitted, every other caller is unchanged", () => {
    expect(customerLinePrice({ product, tier: 1 })).toMatchObject({
      price: 10,
      priceType: "STANDARD",
    });
  });
});

describe("SA-1068 §3: effectiveBuyerPrice holds the same rule", () => {
  it.each([
    [null, 10, 8],
    [undefined, 10, 8],
    [9.99, 10, 8],
    [10, 10, 8],
    [10.01, 10, 10.01],
    [15, 10, 15],
  ])("remembered %s vs list %s, tier 8 -> %s", (remembered, list, want) => {
    expect(effectiveBuyerPrice(8, list, remembered)).toBe(want);
    expect(isStickyUpsell(remembered, list)).toBe(want !== 8);
  });
});

describe("SA-1068: the remembered marker", () => {
  it("is set only on the sticky branch", () => {
    expect(customerLinePrice({ product, tier: 1, remembered: 15 }).remembered).toBe(true);
    expect(customerLinePrice({ product, tier: 1, remembered: 9 }).remembered).toBeUndefined();
    expect(customerLinePrice({ product, tier: 1 }).remembered).toBeUndefined();
  });
});
