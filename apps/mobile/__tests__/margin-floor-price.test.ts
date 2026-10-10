import { priceForMarginFloor } from "@routeflow/pricing";
import { marginFloorPrice } from "../lib/margin-floor-price";

// #2232 prefactor: marginFloorPrice moved verbatim out of edit-items.tsx — pin its contract.
describe("marginFloorPrice", () => {
  it("is null with no known cost (no cost, no floor)", () => {
    expect(
      marginFloorPrice({ averageCost: null, unitPrice: 5, unitsPerBox: null }, 0.2),
    ).toBeNull();
  });

  it("with a known cost it returns the floor price whatever the current price (classifyMargin is only null for a null margin)", () => {
    expect(marginFloorPrice({ averageCost: 1, unitPrice: 100, unitsPerBox: null }, 0.2)).toBe(
      priceForMarginFloor(1, 0.2, null),
    );
  });

  it("below the floor, returns priceForMarginFloor for the per-piece cost (string cost accepted)", () => {
    expect(marginFloorPrice({ averageCost: "10", unitPrice: 5, unitsPerBox: null }, 0.2)).toBe(
      priceForMarginFloor(10, 0.2, null),
    );
  });
});
