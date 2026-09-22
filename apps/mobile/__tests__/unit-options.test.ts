import type { ProductUnitLevel } from "@routeflow/types";
import {
  buildUnitOptions,
  unitLineSubtotal,
  unitOptionText,
  unitPriceBase,
} from "../lib/unit-options";

/**
 * Golden parity spec (house convention — see `enum-parity.spec.ts`,
 * `returns-reason-parity.spec.ts`): mobile cannot import `apps/web`, so this pins
 * `unitOptionText`'s output against the LITERAL expected strings in
 * `apps/web/lib/unit-options.test.ts`'s own "unitOptionText" describe block, using the SAME
 * fixtures. If web's formatting ever changes, this test — not a shared import — is what forces
 * the mobile copy to be updated in the same PR. Source of truth: apps/web/lib/unit-options.test.ts.
 */

const product = {
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: "42.00",
  priceTier2: "21.00",
  priceTier3: "0",
};

const level = (
  over: Partial<ProductUnitLevel> & Pick<ProductUnitLevel, "label" | "factorToBase">,
) =>
  ({
    id: over.label,
    price: null,
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
    isDefaultSelling: false,
    sortOrder: 0,
    ...over,
  }) as ProductUnitLevel;

const CASE = level({ label: "Case", factorToBase: 288, price: "480.00" });
const PALLET = level({ label: "Pallet", factorToBase: 5760 });

describe("unitOptionText — parity with apps/web/lib/unit-options.test.ts", () => {
  it("shows the label, pieces per unit and the price; a single piece omits the count", () => {
    const [pack, , , piece] = buildUnitOptions(product, [CASE, PALLET]);
    expect(unitOptionText(pack)).toBe("Box · 24 pcs · $42.00");
    expect(unitOptionText(buildUnitOptions(product, [PALLET])[1])).toBe(
      "Pallet · 5760 pcs · $10,080.00",
    );
    expect(unitOptionText(piece)).toBe("Piece · $1.75");
  });
});

describe("buildUnitOptions", () => {
  it("a product with no levels offers only the pack, sent as an empty unitLabel", () => {
    expect(buildUnitOptions(product, [])).toEqual([
      { value: "", label: "Box", factorToBase: 24, kind: "pack", price: 42, listPrice: 42 },
    ]);
  });

  it("lists pack, then levels largest to smallest, then the implicit Piece — priced by the server ladder", () => {
    const opts = buildUnitOptions(product, [CASE, PALLET]);
    expect(opts.map((o) => [o.value, o.factorToBase, o.kind, o.price])).toEqual([
      ["", 24, "pack", 42],
      ["Pallet", 5760, "level", 10080], // derived: 42 x 5760 / 24
      ["Case", 288, "level", 480], // explicit
      ["Piece", 1, "piece", 1.75], // 42 / 24
    ]);
  });
});

describe("unitLineSubtotal", () => {
  const opts = buildUnitOptions(product, [CASE, PALLET]);
  const by = (v: string) => opts.find((o) => o.value === v)!;

  it("counts the unit, never pieces x price", () => {
    expect(unitLineSubtotal(by("Case"), 3)).toBe(1440);
    expect(unitLineSubtotal(by("Piece"), 5)).toBe(8.75);
    expect(unitLineSubtotal(by(""), 2)).toBe(84);
  });

  it("honours a typed price and returns 0 for a non-positive count", () => {
    expect(unitLineSubtotal(by("Case"), 3, 400)).toBe(1200);
    expect(unitLineSubtotal(by("Case"), 0)).toBe(0);
    expect(unitLineSubtotal(by("Case"), Number.NaN)).toBe(0);
  });
});

describe("unitPriceBase — the price-comparison-baseline fix (same shape as B465 on #1252)", () => {
  it("uses catalogPrice while no unit is selected — a plain pack line is unaffected", () => {
    expect(unitPriceBase({ unitLabel: undefined, unitBasePrice: undefined }, 42)).toBe(42);
    expect(unitPriceBase({ unitLabel: null }, 42)).toBe(42);
  });

  it("uses the ACTIVE unit's own resolved price once one is selected, never the pack's catalogPrice", () => {
    // A Case at $220 vs a Box at $42 — comparing against catalogPrice (42) would misclassify
    // an untouched $220 Case selection as a $178 manual override.
    expect(unitPriceBase({ unitLabel: "Case", unitBasePrice: 220 }, 42)).toBe(220);
  });

  it("falls back to catalogPrice when unitBasePrice is unset (a line loaded already unit-aware this session hasn't touched) — documented, unchanged pre-existing behaviour", () => {
    expect(unitPriceBase({ unitLabel: "Case", unitBasePrice: undefined }, 42)).toBe(42);
  });
});
