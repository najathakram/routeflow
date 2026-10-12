import { priceRowLabel } from "./product-unit-label";

/** UX CHANGE (330 copy): the product detail's price row reads "Price each (tier 1)", not "Price per each (Tier 1)". */
describe("priceRowLabel", () => {
  it("an each-priced product reads 'Price each (tier 1)' (no 'per each')", () => {
    expect(priceRowLabel("each", "Tier 1")).toBe("Price each (tier 1)");
  });

  it("a pack unit keeps 'per': 'Price per case (tier 1)'", () => {
    expect(priceRowLabel("case", "Tier 1")).toBe("Price per case (tier 1)");
  });

  it("a tenant's own tier name is left exactly as they wrote it", () => {
    expect(priceRowLabel("each", "Wholesale")).toBe("Price each (Wholesale)");
  });
});
