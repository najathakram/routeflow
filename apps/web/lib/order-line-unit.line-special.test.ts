import { isSpecialTier, type CustomerLayerUnit } from "@routeflow/pricing";
import { isLayerManualLine, lineIsSpecialAt } from "./order-line-unit";
import { saleLinePricing } from "./sale-line-pricing";

// S19b integration review MUST-1: SPECIAL-ness is judged PER LINE (the line's own unit row), like mobile's lineIsSpecial,
// so a Case line answers with the Case row and never the pack's.
const row = (over: Partial<CustomerLayerUnit>): CustomerLayerUnit => ({
  ref: "pack",
  label: null,
  price: 33,
  listPrice: 42,
  source: "customer",
  aboveList: false,
  ...over,
});
const pack = row({}); // 33 vs list 42: SPECIAL
const caseAtList = row({ ref: "u-case", label: "Case", price: 380, listPrice: 380 }); // not special
const caseBelow = row({ ref: "u-case", label: "Case", price: 360, listPrice: 380 }); // special

describe("lineIsSpecialAt", () => {
  it("a unit line answers with its OWN unit row, not the pack's", () => {
    expect(
      lineIsSpecialAt({ tier: 1, layer: [pack, caseAtList], line: { unitLabel: "Case" } }),
    ).toBe(false);
    expect(
      lineIsSpecialAt({ tier: 1, layer: [pack, caseBelow], line: { unitLabel: "Case" } }),
    ).toBe(true);
    expect(lineIsSpecialAt({ tier: 1, layer: [pack, caseAtList] })).toBe(true); // the pack line
  });
  it("a unit with no layer row falls to master's isSpecialTier(tier)", () => {
    expect(lineIsSpecialAt({ tier: 3, layer: [pack], line: { unitLabel: "Pallet" } })).toBe(true);
    expect(lineIsSpecialAt({ tier: 1, layer: [pack], line: { unitLabel: "Pallet" } })).toBe(false);
  });
  it("a derived Piece bills as the pack: it answers with the pack row", () => {
    expect(
      lineIsSpecialAt({ tier: 1, layer: [pack, caseAtList], line: { derivedBase: "Piece" } }),
    ).toBe(true);
  });
  it("no layer (flag off) is master's isSpecialTier for every tier and line", () => {
    for (const t of [0, 1, 2, 3, 4, 5, 6]) {
      expect(lineIsSpecialAt({ tier: t })).toBe(isSpecialTier(t));
      expect(lineIsSpecialAt({ tier: t, line: { unitLabel: "Case" } })).toBe(isSpecialTier(t));
    }
  });
});

describe("saleLinePricing with a layer line (SHOULD 3)", () => {
  const product = { pricePerUnit: "48" };
  it("a null list never becomes 0: it takes the line's own price (nothing is 'above list')", () => {
    const r = saleLinePricing(product, 3, {
      price: 21,
      listPrice: null,
      isSpecial: true,
      priceType: "SPECIAL",
      layered: false,
    });
    expect(r).toEqual({ tierPrice: 21, listPrice: 21, isSpecialTier: true });
  });
  it("a real list passes through", () => {
    const r = saleLinePricing(product, 3, {
      price: 40,
      listPrice: 48,
      isSpecial: true,
      priceType: "SPECIAL",
      layered: true,
    });
    expect(r.listPrice).toBe(48);
  });
});

describe("lineIsSpecialAt with the real product (review nit 2)", () => {
  // a product whose pack is named "Case" and a LEVEL literally named "Box": the "Box" row is the level's own, not the pack's
  const boxLevel = row({ ref: "u-box", label: "Box", price: 30, listPrice: 30 }); // not special
  it("with {} the label 'Box' reads the PACK row (wrong); with the real product it reads the level's row", () => {
    const layer = [pack, boxLevel];
    expect(lineIsSpecialAt({ tier: 1, layer, line: { unitLabel: "Box" } })).toBe(true);
    expect(
      lineIsSpecialAt({
        tier: 1,
        layer,
        line: { unitLabel: "Box" },
        product: { unit: "Case", unitsPerBox: 24 },
      }),
    ).toBe(false);
  });
});

describe("isLayerManualLine (the picker's re-price mark)", () => {
  const aboveRow = row({ ref: "pack", price: 50, listPrice: 42, aboveList: true });
  const line = {
    unit: "Box",
    listPrice: 42,
    priceType: "MANUAL",
    unitLabel: undefined as string | undefined,
  };
  it("true only for a MANUAL line the operator did not shape, on a unit whose layer row is above list", () => {
    expect(isLayerManualLine(line, [aboveRow])).toBe(true);
    expect(isLayerManualLine({ ...line, discountedPrice: 50 }, [aboveRow])).toBe(false);
    expect(isLayerManualLine({ ...line, priceEdited: true }, [aboveRow])).toBe(false);
    expect(isLayerManualLine({ ...line, priceType: "SPECIAL" }, [aboveRow])).toBe(false);
    expect(isLayerManualLine(line, [pack])).toBe(false);
  });
  it("flag off (no layer) is never layer-manual: master skips every MANUAL line", () => {
    expect(isLayerManualLine(line, undefined)).toBe(false);
    expect(isLayerManualLine(line, null)).toBe(false);
  });
});
