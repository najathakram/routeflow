import { computeLineSubtotal, effectiveQty } from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";
import type { LineState } from "../lib/cart-line-state";
import { applyUnitOption } from "../lib/default-unit-line";
import { applyUnitPick, type DraftItem } from "../lib/edit-items-draft";
import { buildUnitOptions, unitPickerValue } from "../lib/unit-options";

/**
 * SA-728 / units P0b: a derived-Piece pick is a PACK-PIECES line — boxes/pieces, no unitLabel — so the preview total
 * is the server's (computeLineSubtotal), never qty x a rounded per-piece price. An own-priced Piece keeps the unit path.
 */
const pack3 = { unit: "Pack", unitsPerBox: 3, pricePerUnit: "10.00" };
const lvl = (label: string, factorToBase: number, price: string | null): ProductUnitLevel =>
  ({
    id: label,
    label,
    factorToBase,
    price,
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
    isDefaultSelling: false,
    sortOrder: 0,
  }) as ProductUnitLevel;
const derived = buildUnitOptions(pack3, [lvl("Case", 12, null)], 1);
const owned = buildUnitOptions(pack3, [lvl("Case", 12, null), lvl("Piece", 1, "3.00")], 1);
const pick = (opts: typeof derived, v: string) => opts.find((o) => o.value === v)!;

describe.skip("cart (applyUnitOption): derived Piece", () => {
  const packLine: LineState = { qty: 3, boxes: 1, pieces: 0 };
  it("2 pcs of a 3-pack @ $10 previews $6.67 with boxes 0 / pieces 2 and no unitLabel", () => {
    const one = applyUnitOption(packLine, pick(derived, "Piece"), 3);
    expect(one.unitLabel).toBeUndefined();
    expect(one).toMatchObject({ boxes: 0, pieces: 1, qty: 1, unitPrice: undefined });
    expect(unitPickerValue(one)).toBe("Piece");
    const two: LineState = { ...one, pieces: 2, qty: 2 };
    expect(
      computeLineSubtotal({
        unitPrice: 10,
        qty: effectiveQty(two, 3),
        boxes: two.boxes ?? null,
        pieces: two.pieces ?? null,
        unitsPerBox: 3,
      }),
    ).toBe(6.67);
  });
  it("back to the pack clears the marker; an own-priced Piece keeps the unit-line path", () => {
    const one = applyUnitOption(packLine, pick(derived, "Piece"), 3);
    const back = applyUnitOption(one, pick(derived, ""), 3);
    expect(unitPickerValue(back)).toBe("");
    const own = applyUnitOption(packLine, pick(owned, "Piece"), 3);
    expect(own).toMatchObject({ unitLabel: "Piece", unitBasePrice: 3 });
    expect(own.boxes).toBeUndefined();
  });
});

describe.skip("order edit (applyUnitPick): derived Piece", () => {
  const item = {
    productId: "p",
    qty: 3,
    boxes: 1,
    pieces: 0,
    boxSplit: true,
    unitsPerBox: 3,
    unitPrice: 10,
    catalogPrice: 10,
    name: "x",
    packLadder: { unit: "Pack", unitsPerBox: 3, pricePerUnit: "10.00" },
  } as DraftItem;
  it("is a pack-pieces line: boxSplit, boxes 0 / pieces 1, pack price, no unitLabel", () => {
    const one = applyUnitPick(item, pick(derived, "Piece"), 10);
    expect(one.unitLabel).toBeUndefined();
    expect(one).toMatchObject({
      boxSplit: true,
      boxes: 0,
      pieces: 1,
      qty: 1,
      unitsPerBox: 3,
      unitPrice: 10,
    });
    expect(unitPickerValue(one)).toBe("Piece");
  });
  it("back to the pack and an own-priced Piece behave as before", () => {
    const one = applyUnitPick(item, pick(derived, "Piece"), 10);
    expect(unitPickerValue(applyUnitPick(one, pick(derived, ""), 10))).toBe("");
    expect(applyUnitPick(item, pick(owned, "Piece"), 10)).toMatchObject({
      unitLabel: "Piece",
      unitPrice: 3,
    });
  });
});
