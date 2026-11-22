import { onHandLabel, poLineName } from "./purchase-orders-shared";

describe("onHandLabel (P1b)", () => {
  it("splits by the product's CURRENT pack: 30 pcs after a repack 12 -> 6 is 5 boxes", () => {
    expect(onHandLabel("30.000", 12)).toBe("30 pcs (2 boxes + 6 pcs)");
    expect(onHandLabel("30.000", 6)).toBe("30 pcs (5 boxes)");
  });
  it("gives a pack of 1 or an unknown pack a thousands separator and a unit", () => {
    expect(onHandLabel(12000, 1)).toBe("12,000 pcs");
    expect(onHandLabel(12000, 0)).toBe("12,000 pcs");
  });
  it("shows negative stock plainly, with no box split", () => {
    expect(onHandLabel(-5, 12)).toBe("-5 pcs");
  });
  it("keeps a fraction visible and does not split it", () => {
    expect(onHandLabel("30.500", 12)).toBe("30.5 pcs");
  });
  it("is a dash when the read carries no figure", () => {
    expect(onHandLabel(null, 12)).toBe("—");
    expect(onHandLabel(undefined, 0)).toBe("—");
  });
});

describe("poLineName (P1b)", () => {
  it("composes <Family> - <Variant> from the line's own include, with no catalog", () => {
    const product = {
      id: "p",
      name: "Strawberry",
      unit: "case",
      parentProductId: "f",
      variantName: "Strawberry",
      parent: { name: "Acme Vape" },
    };
    expect(poLineName({ product })).toBe("Acme Vape - Strawberry");
  });
  it("is a dash when neither the include nor the catalog has a name", () => {
    expect(poLineName({ product: null })).toBe("—");
  });
});
