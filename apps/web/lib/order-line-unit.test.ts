import { computeLineSubtotal, normalizeBoxesPieces } from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";
import { buildUnitOptions, type UnitOption } from "./unit-options";
import {
  applyLineUnit,
  ladderProductOf,
  mergeSameLine,
  sameProductUnit,
  unitLabelPayload,
  unitPickerValueOf,
  type UnitLine,
} from "./order-line-unit";

const product = { unit: "Box", unitsPerBox: 24, pricePerUnit: "42.00", priceTier2: "21.00" };
const level = (label: string, factorToBase: number, price: string | null): ProductUnitLevel => ({
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
});
const options = (tier = 1) =>
  buildUnitOptions(product, [level("Case", 288, "480.00"), level("Pallet", 5760, null)], tier);
const by = (opts: UnitOption[], v: string) => opts.find((o) => o.value === v)!;

// a pack line as the modal builds it: 1 Box of a 24-piece product, an operator's one-time $40 price
const packLine: UnitLine & { tempId: string; productId: string } = {
  tempId: "t1",
  productId: "p1",
  unit: "Box",
  qty: 24,
  unitsPerBox: 24,
  boxes: 1,
  pieces: 0,
  sellBy: "case",
  listPrice: 42,
  unitPrice: 40,
  priceType: "DISCOUNTED",
  discountedPrice: 40,
  unitCost: 1.5, // per piece
};

describe("applyLineUnit", () => {
  it("switching to a level makes a plain-quantity unit line: count 1, the ladder price, no boxes/pieces", () => {
    const line = applyLineUnit(packLine, by(options(), "Case"), { tier: 1 });
    expect(line).toMatchObject({
      unitLabel: "Case",
      unit: "Case",
      qty: 1,
      listPrice: 480,
      unitPrice: 480,
      priceType: "STANDARD",
      specialPrice: undefined,
      discountedPrice: undefined, // the pack's one-time override does not carry to the Case
      unitsPerBox: undefined,
      boxes: undefined,
      pieces: undefined,
      sellBy: undefined,
    });
    expect(line.unitCost).toBe(1.5 * 288); // margin-hint cost per CASE
    expect(line.packBase).toMatchObject({ unit: "Box", unitsPerBox: 24, discountedPrice: 40 });
  });

  it("a non-first tier prices the line SPECIAL at the tier's ladder price", () => {
    const line = applyLineUnit(packLine, by(options(2), "Case"), { tier: 2 });
    // the unit's LIST price stays its tier-1 price: a typed price is compared against that
    expect(line).toMatchObject({
      listPrice: 480,
      unitPrice: 240,
      priceType: "SPECIAL",
      specialPrice: 240,
    });
  });

  it("level to level keeps the ORIGINAL pack snapshot, never the intermediate unit line", () => {
    const opts = options();
    const asCase = applyLineUnit(packLine, by(opts, "Case"), { tier: 1 });
    const asPallet = applyLineUnit(asCase, by(opts, "Pallet"), { tier: 1 });
    expect(asPallet).toMatchObject({ unitLabel: "Pallet", unitPrice: 10080, qty: 1 });
    expect(asPallet.packBase).toEqual(asCase.packBase);
    expect(asPallet.packBase?.unitsPerBox).toBe(24);
  });

  it("choosing the pack again restores the line exactly and drops the snapshot", () => {
    const opts = options();
    const asCase = applyLineUnit(packLine, by(opts, "Case"), { tier: 1 });
    const back = applyLineUnit(asCase, by(opts, ""), { tier: 1 });
    expect(back).toEqual({ ...packLine, unitLabel: undefined });
    expect(back.packBase).toBeUndefined();
  });

  describe("restoring the pack after the customer's tier moved (review defect 1)", () => {
    const tierPrices = { pricePerUnit: "42.00", priceTier2: "21.00" };
    const autoPriced = (tier: 1 | 2): typeof packLine & { tierPrices: typeof tierPrices } => ({
      ...packLine,
      tierPrices,
      discountedPrice: undefined,
      unitPrice: tier === 2 ? 21 : 42,
      priceType: tier === 2 ? "SPECIAL" : "STANDARD",
      specialPrice: tier === 2 ? 21 : undefined,
    });

    it("re-derives the auto price at the CURRENT tier, not the snapshot's (tier 2 -> 1)", () => {
      const opts = options();
      const asCase = applyLineUnit(autoPriced(2), by(options(2), "Case"), { tier: 2 });
      const back = applyLineUnit(asCase, by(opts, ""), { tier: 1 }); // the customer changed to tier 1
      expect(back).toMatchObject({ unitPrice: 42, priceType: "STANDARD", specialPrice: undefined });
    });

    it("...and the other way (tier 1 -> 2)", () => {
      const asCase = applyLineUnit(autoPriced(1), by(options(), "Case"), { tier: 1 });
      const back = applyLineUnit(asCase, by(options(2), ""), { tier: 2 });
      expect(back).toMatchObject({ unitPrice: 21, priceType: "SPECIAL", specialPrice: 21 });
    });

    it("an operator's one-time price is theirs: it survives the round trip and a tier change", () => {
      const withOverride = {
        ...autoPriced(1),
        unitPrice: 40,
        priceType: "DISCOUNTED" as const,
        discountedPrice: 40,
      };
      const asCase = applyLineUnit(withOverride, by(options(), "Case"), { tier: 1 });
      const back = applyLineUnit(asCase, by(options(2), ""), { tier: 2 });
      expect(back).toMatchObject({ unitPrice: 40, priceType: "DISCOUNTED", discountedPrice: 40 });
    });
  });

  it("choosing the pack on a line that never left it changes nothing", () => {
    expect(applyLineUnit(packLine, by(options(), ""), { tier: 1 })).toBe(packLine);
  });

  it("a price refresh (tier change) keeps the typed count; a real unit switch resets it to 1", () => {
    const opts = options();
    const asCase = { ...applyLineUnit(packLine, by(opts, "Case"), { tier: 1 }), qty: 5 };
    expect(applyLineUnit(asCase, by(options(2), "Case"), { tier: 2, keepQty: true }).qty).toBe(5);
    expect(applyLineUnit(asCase, by(opts, "Pallet"), { tier: 1, keepQty: true }).qty).toBe(1);
  });
});

describe("ladderProductOf", () => {
  it("reads the PACK (from the snapshot) even while the line sells by a unit", () => {
    const opts = options();
    const asCase = applyLineUnit(packLine, by(opts, "Case"), { tier: 1 });
    const lp = ladderProductOf({
      ...asCase,
      listPrice: 42,
      tierPrices: { pricePerUnit: "42.00", priceTier2: "21.00" },
    });
    expect(lp).toMatchObject({ unit: "Box", unitsPerBox: 24, pricePerUnit: "42.00" });
    expect(lp.priceTier2).toBe("21.00");
  });

  it("falls back to the line's list price when it has no tier snapshot", () => {
    expect(ladderProductOf({ unit: "Bag", listPrice: 5 })).toMatchObject({
      unit: "Bag",
      unitsPerBox: null,
      pricePerUnit: "5",
    });
  });
});

describe("submit + merge keys", () => {
  it("sends unitLabel only for a non-pack unit", () => {
    expect(unitLabelPayload({ unitLabel: "Case" })).toEqual({ unitLabel: "Case" });
    expect(unitLabelPayload({ unitLabel: undefined })).toEqual({});
    expect(unitLabelPayload({ unitLabel: "" })).toEqual({});
  });

  it("a Case and a Box of one product are different lines; same product and unit is the same line", () => {
    expect(sameProductUnit({ productId: "p", unitLabel: "Case" }, { productId: "p" })).toBe(false);
    expect(
      sameProductUnit({ productId: "p", unitLabel: "Case" }, { productId: "p", unitLabel: "Case" }),
    ).toBe(true);
    expect(sameProductUnit({ productId: "p" }, { productId: "p", unitLabel: "" })).toBe(true);
    expect(
      sameProductUnit({ productId: "p", unitLabel: "Case" }, { productId: "q", unitLabel: "Case" }),
    ).toBe(false);
  });
});

describe("mergeSameLine", () => {
  it("unit lines add their counts", () => {
    expect(mergeSameLine({ qty: 3 }, { qty: 2 })).toEqual({ qty: 5 });
  });

  it("pack lines add boxes and pieces and roll pieces over: 1 box + 20 pcs and 1 box + 10 pcs of a 24-box", () => {
    const a = { qty: 44, unitsPerBox: 24, boxes: 1, pieces: 20 };
    const b = { qty: 34, unitsPerBox: 24, boxes: 1, pieces: 10 };
    expect(mergeSameLine(a, b)).toEqual({ qty: 78, unitsPerBox: 24, boxes: 3, pieces: 6 });
  });
});

describe("SA-728 / units P0b: a derived-Piece pick is a PACK-PIECES line (preview == server)", () => {
  const pack3 = { unit: "Pack", unitsPerBox: 3, pricePerUnit: "10.00" };
  const opts = buildUnitOptions(pack3, [level("Case", 12, null)], 1);
  const line3: UnitLine & { tempId: string; productId: string } = {
    tempId: "t3",
    productId: "p3",
    unit: "Pack",
    qty: 3,
    unitsPerBox: 3,
    boxes: 1,
    pieces: 0,
    sellBy: "case",
    listPrice: 10,
    unitPrice: 10,
    priceType: "STANDARD",
  };
  const preview = (li: UnitLine) =>
    computeLineSubtotal({
      unitPrice: li.unitPrice,
      qty: li.qty,
      boxes: li.boxes ?? null,
      pieces: li.pieces ?? null,
      unitsPerBox: li.unitsPerBox ?? null,
    });

  it("2 pcs of a 3-pack @ $10: boxes 0 / pieces 2, no unitLabel, preview total $6.67 (== the server's)", () => {
    const one = applyLineUnit(line3, by(opts, "Piece"), { tier: 1 });
    const n = normalizeBoxesPieces({ qty: 2, unitsPerBox: 3 });
    const two = { ...one, boxes: n.boxes ?? 0, pieces: n.pieces ?? 0, qty: n.qty };
    expect(one.unitLabel).toBeUndefined();
    expect(unitLabelPayload(one)).toEqual({});
    expect(one).toMatchObject({ unitsPerBox: 3, boxes: 0, pieces: 1, qty: 1, unitPrice: 10 });
    expect(two).toMatchObject({ boxes: 0, pieces: 2, qty: 2 });
    expect(preview(two)).toBe(6.67);
  });

  it("the picker still shows Piece as selected, and switching back restores the pack line", () => {
    const one = applyLineUnit(line3, by(opts, "Piece"), { tier: 1 });
    expect(unitPickerValueOf(one)).toBe("Piece");
    const back = applyLineUnit(one, by(opts, ""), { tier: 1 });
    expect(unitPickerValueOf(back)).toBe("");
    expect(back).toMatchObject({ unitsPerBox: 3, boxes: 1, pieces: 0, qty: 3 });
  });

  it("an OWN-priced Piece row keeps the unit-line path (unitLabel Piece, price per piece)", () => {
    const own = buildUnitOptions(pack3, [level("Case", 12, null), level("Piece", 1, "3.00")], 1);
    const li = applyLineUnit(line3, by(own, "Piece"), { tier: 1 });
    expect(li).toMatchObject({ unitLabel: "Piece", unitPrice: 3, qty: 1 });
    expect(unitLabelPayload(li)).toEqual({ unitLabel: "Piece" });
  });

  it("a level pick from a derived-Piece line snapshots the PACK, not the pieces state", () => {
    const one = applyLineUnit(line3, by(opts, "Piece"), { tier: 1 });
    const caseLine = applyLineUnit(one, by(opts, "Case"), { tier: 1 });
    const back = applyLineUnit(caseLine, by(opts, ""), { tier: 1 });
    expect(back).toMatchObject({ unitsPerBox: 3, boxes: 1, pieces: 0, qty: 3 });
  });
});
