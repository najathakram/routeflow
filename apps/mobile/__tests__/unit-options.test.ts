import type { ProductUnitLevel } from "@routeflow/types";
import { resolveUnitPrice } from "@routeflow/pricing";
import {
  buildUnitOptions,
  defaultStartOption,
  defaultUnitValue,
  marginFactorFor,
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

describe("buildUnitOptions at a non-1 tier ties to the server's own pricer (SA-085f HIGH #2)", () => {
  it("prices a level off the PRODUCT's OWN tier-2 column, agreeing with resolveUnitPrice called independently", () => {
    const opts = buildUnitOptions(product, [CASE, PALLET], 2);
    const at = (v: string) => opts.find((o) => o.value === v)!;
    expect(at("Case").price).toBe(240); // 480 (tier1, explicit) x 21/42 (pack's tier2/tier1 ratio)
    expect(at("Case").price).toBe(resolveUnitPrice(product, [CASE, PALLET], "Case", 2));
    expect(at("Pallet").price).toBe(resolveUnitPrice(product, [CASE, PALLET], "Pallet", 2));
  });

  it("RED PROOF: a mini-product missing the pack's tier columns (UnitPickerRow's old { unit, unitsPerBox, pricePerUnit: listPrice }) prices every tier the same as tier 1", () => {
    const brokenMiniProduct = {
      unit: product.unit,
      unitsPerBox: product.unitsPerBox,
      pricePerUnit: product.pricePerUnit, // no priceTier2/3 — the shipped shape
    };
    const broken = buildUnitOptions(brokenMiniProduct, [CASE, PALLET], 2);
    expect(broken.find((o) => o.value === "Case")!.price).toBe(480); // wrong: tier 1's price
    // The real product, proven above, correctly diverges from it at tier 2.
    expect(
      buildUnitOptions(product, [CASE, PALLET], 2).find((o) => o.value === "Case")!.price,
    ).toBe(240);
  });

  it("RED PROOF: a mini-product carrying a STORED unit line's OWN factor as unitsPerBox (the other shipped bug — edit-items.tsx's old mini-product) mis-derives the Piece's price", () => {
    // A stored Case line snapshots unitsPerBox = the Case's own factor (288), not the pack's
    // real 24 (server: unit-line-build.ts's `unitsPerBox: factor`) — exactly what the old
    // mini-product carried forward as the ladder's pack factor.
    const brokenMiniProduct = {
      unit: product.unit,
      unitsPerBox: 288,
      pricePerUnit: product.pricePerUnit,
    };
    const broken = buildUnitOptions(brokenMiniProduct, [CASE, PALLET], 1);
    const real = buildUnitOptions(product, [CASE, PALLET], 1);
    expect(real.find((o) => o.value === "Piece")!.price).toBe(1.75); // 42 / 24, golden fixture above
    expect(broken.find((o) => o.value === "Piece")!.price).toBe(0.15); // 42 / 288 — a silent under-bill
  });
});

describe("marginFactorFor (SA-085f HIGH #3)", () => {
  it("uses the pack's unitsPerBox while no unit is selected — unchanged, pre-existing behaviour", () => {
    expect(marginFactorFor({ unitLabel: undefined }, 24)).toBe(24);
    expect(marginFactorFor({ unitLabel: null }, 24)).toBe(24);
  });

  it("uses the CHOSEN unit's own factor once one is selected, never the pack's", () => {
    // A Case's factor (288) is nothing like the pack's (24) — cost-per-piece x 288, not x 24.
    expect(marginFactorFor({ unitLabel: "Case", unitFactor: 288 }, 24)).toBe(288);
  });

  it("falls back to 1 when a unit is selected but its factor wasn't stored (defensive, should not happen)", () => {
    expect(marginFactorFor({ unitLabel: "Case", unitFactor: undefined }, 24)).toBe(1);
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

describe("defaultUnitValue (#2784) — mirrors web's, both on @routeflow/pricing's defaultSellingLabel", () => {
  it("is the level flagged isDefaultSelling, else the pack", () => {
    expect(defaultUnitValue(product, [CASE, PALLET])).toBe("");
    expect(defaultUnitValue(product, [CASE, { ...PALLET, isDefaultSelling: true }])).toBe("Pallet");
  });

  it("never names a label the picker does not offer", () => {
    expect(
      defaultUnitValue(product, [
        level({ label: "box", factorToBase: 12, isDefaultSelling: true }),
      ]),
    ).toBe("");
    expect(
      defaultUnitValue(product, [
        level({ label: "Piece", factorToBase: 1, isDefaultSelling: true }),
      ]),
    ).toBe("Piece");
  });

  it("skips a corrupt flagged row and takes the next valid one", () => {
    expect(
      defaultUnitValue(product, [
        level({ label: "Bad", factorToBase: 0, isDefaultSelling: true }),
        { ...PALLET, isDefaultSelling: true },
      ]),
    ).toBe("Pallet");
  });
});

describe("defaultStartOption (#2784): the option a NEW line starts on", () => {
  const FLAGGED = { ...CASE, isDefaultSelling: true };

  it("is the flagged default level's option", () => {
    expect(defaultStartOption(product, [FLAGGED], 1, { hasUnit: false })?.value).toBe("Case");
  });

  it("is null when nothing is flagged, the line already holds a unit, or the price was typed", () => {
    expect(defaultStartOption(product, [CASE], 1, { hasUnit: false })).toBeNull();
    expect(defaultStartOption(product, [FLAGGED], 1, { hasUnit: true })).toBeNull();
    expect(
      defaultStartOption(product, [FLAGGED], 1, { hasUnit: false, priceEdited: true }),
    ).toBeNull();
    expect(defaultStartOption(product, [], 1, { hasUnit: false })).toBeNull();
  });
});
