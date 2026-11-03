import { costAbovePiecePrice } from "./pack-intro-cost-check";

describe("costAbovePiecePrice (SA-961 R1, dry-run count)", () => {
  it("includes a product priced 24.00 with cost 20.00 at N = 24", () => {
    expect(costAbovePiecePrice({ pricePerUnit: "24.00", averageCost: "20.0000" }, 24)).toBe(true);
  });

  it("excludes cost 0.50 at the same price and N", () => {
    expect(costAbovePiecePrice({ pricePerUnit: "24.00", averageCost: "0.5000" }, 24)).toBe(false);
  });

  it("excludes a cost equal to the piece price, a missing cost and a pack of 1", () => {
    expect(costAbovePiecePrice({ pricePerUnit: 24, averageCost: 1 }, 24)).toBe(false);
    expect(costAbovePiecePrice({ pricePerUnit: 24, averageCost: null }, 24)).toBe(false);
    expect(costAbovePiecePrice({ pricePerUnit: 24, averageCost: 20 }, 1)).toBe(false);
  });
});
