import { customerLinePrice } from "@routeflow/pricing";
import { catalogPricing } from "./invoice-catalog-price";

// S19b slice C: catalogPricing takes the customer-layer line (SA-811a). Above-list is MANUAL with no promo (R2); an unlayered
// product is master's numbers exactly.
const PRODUCT = { id: "p1", pricePerUnit: "42", priceTier3: "36" };
const row = (price: number, aboveList = false) => ({
  ref: "pack",
  label: null,
  price,
  listPrice: 42,
  source: "customer" as const,
  aboveList,
});
const layerLine = (price: number, aboveList = false) =>
  customerLinePrice({ product: PRODUCT, tier: 3, layer: [row(price, aboveList)], unitLabel: null });

describe("catalogPricing with a customer-layer line", () => {
  it("a typed pack $33 (list $42, tier $36) lands on $33, SPECIAL", () => {
    const r = catalogPricing(PRODUCT, { customerTier: 3, lineTier: 3, layerLine: layerLine(33) });
    expect(r).toMatchObject({
      effectivePrice: 33,
      listPrice: 42,
      isSpecial: true,
      priceType: "SPECIAL",
    });
  });

  it("R2: above list ($45 on $42) is MANUAL at $45", () => {
    const r = catalogPricing(PRODUCT, {
      customerTier: 3,
      lineTier: 3,
      layerLine: layerLine(45, true),
    });
    expect(r).toMatchObject({ effectivePrice: 45, priceType: "MANUAL" });
  });

  it("no layer line: master's tier price ($36), SPECIAL", () => {
    const r = catalogPricing(PRODUCT, { customerTier: 3, lineTier: 3 });
    expect(r).toMatchObject({ effectivePrice: 36, priceType: "SPECIAL" });
  });
});
