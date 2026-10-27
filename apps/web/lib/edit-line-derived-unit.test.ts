import type { ProductUnitLevel } from "@routeflow/types";
import { derivedUnitPatch } from "@/lib/edit-line-derived-unit";
import { buildUnitOptions } from "@/lib/unit-options";

// A $10.00 3-pack with a Case level and no Piece row: the Piece is DERIVED (a third of the pack price).
const pack3 = { unit: "Pack", unitsPerBox: 3, pricePerUnit: "10.00" };
const CASE = {
  id: "Case",
  label: "Case",
  factorToBase: 72,
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 0,
} as ProductUnitLevel;

const options = buildUnitOptions(pack3, [CASE]);
const packOption = options.find((o) => o.kind === "pack")!;
const caseOption = options.find((o) => o.value === "Case")!;
const piece = options.find((o) => o.factorToBase === 1)!;

describe("derivedUnitPatch (order-edit page, units P0b / SA-728)", () => {
  it("a derived Piece pick is the PACK line's pieces: pack size, pack price, no unit label", () => {
    expect(derivedUnitPatch({ qty: 4, unitsPerBox: 3 }, piece, false)).toEqual({
      unitLabel: undefined,
      derivedBase: piece.value,
      startOnDefaultUnit: false,
      unitsPerBox: 3,
      boxSplit: true,
      qty: 1,
      unitPrice: 10,
      basePrice: 10,
      overrideReason: undefined,
      reasonBaselinePrice: 10,
      priceEdited: false,
    });
  });

  it("keeps the piece count only on a refresh of the same derived pick", () => {
    const held = { qty: 5, unitsPerBox: 3, derivedBase: piece.value };
    expect(derivedUnitPatch(held, piece, true)?.qty).toBe(5);
    expect(derivedUnitPatch(held, piece, false)?.qty).toBe(1);
    expect(derivedUnitPatch({ ...held, derivedBase: "other" }, piece, true)?.qty).toBe(1);
  });

  it("back to the pack from a derived Piece is ONE whole pack with the marker gone", () => {
    expect(
      derivedUnitPatch({ qty: 2, unitsPerBox: 3, derivedBase: piece.value }, packOption, false),
    ).toEqual({ derivedBase: undefined, startOnDefaultUnit: false, qty: 3 });
  });

  it("is null when the pick is neither: the pack from a non-derived line, or a level", () => {
    expect(derivedUnitPatch({ qty: 1, unitsPerBox: 3 }, packOption, false)).toBeNull();
    expect(derivedUnitPatch({ qty: 1, unitsPerBox: 3 }, caseOption, false)).toBeNull();
    expect(
      derivedUnitPatch({ qty: 1, unitsPerBox: 3, derivedBase: piece.value }, caseOption, false),
    ).toBeNull();
  });
});
