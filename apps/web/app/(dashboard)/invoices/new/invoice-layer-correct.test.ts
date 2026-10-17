import type { CustomerLinePrice } from "@routeflow/pricing";
import { correctLayerLevelLines } from "./invoice-layer-correct";

// S19b slice C: the one correction every path that lands a unit line on the LADDER price goes through (the default-unit
// start, a draft restore, a resolve at Save). A typed price stands; an unchanged line keeps its identity.
const LAYER: CustomerLinePrice = {
  price: 21,
  listPrice: 24,
  isSpecial: true,
  priceType: "SPECIAL",
  layered: true,
};
const line = (over: Record<string, unknown> = {}) => ({
  key: "k1",
  unitLabel: "Case",
  unitPrice: 22,
  listPrice: 24,
  priceType: "SPECIAL" as const,
  pricing: { tierPrice: 22, listPrice: 24, isSpecialTier: true },
  ...over,
});

describe("correctLayerLevelLines", () => {
  it("restore / default start: a unit line sitting on the ladder $22 is moved to the layer's $21", () => {
    const [out] = correctLayerLevelLines([line()], () => LAYER);
    expect(out).toMatchObject({
      unitPrice: 21,
      listPrice: 24,
      priceType: "SPECIAL",
      isSpecialPrice: true,
      regularPrice: 24,
      pricing: { tierPrice: 21, listPrice: 24, isSpecialTier: true },
    });
  });

  it("a typed price stands", () => {
    const lines = [line({ priceEdited: true, unitPrice: 19 })];
    expect(correctLayerLevelLines(lines, () => LAYER)).toBe(lines);
  });

  it("a pack line (no unitLabel) is left alone", () => {
    const lines = [line({ unitLabel: undefined })];
    expect(correctLayerLevelLines(lines, () => LAYER)).toBe(lines);
  });

  it("no layer row for the line: unchanged", () => {
    const lines = [line()];
    expect(correctLayerLevelLines(lines, () => undefined)).toBe(lines);
  });

  it("already on the layer price: the same array comes back (no re-render loop)", () => {
    const lines = [
      line({
        unitPrice: 21,
        pricing: { tierPrice: 21, listPrice: 24, isSpecialTier: true },
      }),
    ];
    expect(correctLayerLevelLines(lines, () => LAYER)).toBe(lines);
  });
});
