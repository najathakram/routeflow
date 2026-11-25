import { priceFieldLabel, priceFieldUnitWord, priceRowLabel } from "./product-unit-label";

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

/** B1383: a boxed product's price is the BOX price, so the row names the box, not the piece word. */
describe("priceRowLabel on a boxed product (B1383)", () => {
  it("a piece word with a pack size reads 'Price per box (12 cans, tier 1)'", () => {
    expect(priceRowLabel("can", "Tier 1", { unitsPerBox: 12 })).toBe(
      "Price per box (12 cans, tier 1)",
    );
  });

  it("a piece-priced product with no pack size is unchanged", () => {
    expect(priceRowLabel("can", "Tier 1", { unitsPerBox: 1 })).toBe("Price per can (tier 1)");
    expect(priceRowLabel("can", "Tier 1", { unitsPerBox: null })).toBe("Price per can (tier 1)");
  });

  it("a pack unit stays 'Price per case' whatever the pack size", () => {
    expect(priceRowLabel("case", "Tier 1", { unitsPerBox: 12 })).toBe("Price per case (tier 1)");
  });
});

/** B1383 / Q12: an order line of a boxed product quotes its price per BOX, never per the piece word. */
describe("priceFieldUnitWord on a boxed line (B1383 Q12)", () => {
  it("a piece word with a pack size reads the pack word, so the field reads 'Price per Box'", () => {
    const word = priceFieldUnitWord({ unit: "can", unitsPerBox: 12 });
    expect(word).toBe("Box");
    expect(priceFieldLabel(word)).toBe("Price per Box");
  });

  it("a pack word keeps itself; a plain each line stays each; a picked unit wins", () => {
    expect(priceFieldUnitWord({ unit: "case", unitsPerBox: 12 })).toBe("case");
    expect(priceFieldUnitWord({ unit: "each", unitsPerBox: null })).toBe("each");
    expect(priceFieldUnitWord({ unit: "can", unitsPerBox: 1 })).toBe("can");
    expect(priceFieldUnitWord({ unitLabel: "Pallet", unit: "can", unitsPerBox: 12 })).toBe(
      "Pallet",
    );
  });
});
