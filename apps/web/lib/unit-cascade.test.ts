import type { ProductUnitLevel } from "@routeflow/types";
import { proposeCascade } from "./unit-cascade";

const unit = (id: string, label: string, price: string | null): ProductUnitLevel => ({
  id,
  label,
  factorToBase: 12,
  price,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 0,
});

describe("proposeCascade", () => {
  const units = [
    unit("case", "Case", "42.00"),
    unit("pallet", "Pallet", "480.00"),
    unit("d", "Derived", null),
  ];

  it("offers each OTHER explicit-priced level the same proportional move, rounded once", () => {
    // Case 42.00 -> 40.00 (x 40/42): Pallet 480.00 -> 457.14. The edited row and the derived row are excluded.
    expect(proposeCascade(units, "case", 42, 40)).toEqual([
      { unitId: "pallet", label: "Pallet", from: 480, to: 457.14 },
    ]);
  });

  it("never proposes for a level with no explicit price (it derives and follows automatically)", () => {
    expect(
      proposeCascade([unit("case", "Case", "42.00"), unit("d", "Derived", null)], "case", 42, 40),
    ).toEqual([]);
  });

  it.each([
    ["no change", 42, 42],
    ["cleared new price", 42, null],
    ["no previous explicit price", null, 40],
    ["zero old price (no ratio)", 0, 40],
    ["zero new price", 42, 0],
  ])("proposes nothing for %s", (_n, oldP, newP) => {
    expect(proposeCascade(units, "case", oldP as number | null, newP as number | null)).toEqual([]);
  });

  it("skips a level whose proposed price would not change", () => {
    const tiny = [unit("a", "A", "0.01"), unit("b", "B", "10.00")];
    // 0.01 x 41/42 rounds back to 0.01 -> not offered; B 10.00 -> 9.76
    expect(proposeCascade(tiny, "edited", 42, 41)).toEqual([
      { unitId: "b", label: "B", from: 10, to: 9.76 },
    ]);
  });
});
