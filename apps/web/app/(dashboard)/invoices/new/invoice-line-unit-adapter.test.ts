import { computeLineSubtotal } from "@routeflow/pricing";
import { API_ERROR_CODES } from "@routeflow/types";
import type { UnitOption } from "@/lib/unit-options";
import {
  chooseUnit,
  mergeIntoPackLine,
  pickerLineOf,
  saleUnitPriceField,
  unitPayload,
  unitProductIds,
  unitRefusalCopy,
  withTypedPrice,
  type InvoiceUnitFields,
} from "./invoice-line-unit-adapter";

/** VU-4a adapter: invoice line <-> the shared unit helpers. Box 24 @ 48.00; Case 12 pcs @ 24.00 (tier 1). */

const tier1 = () => 1;
const tier3 = () => 3;
const CASE: UnitOption = {
  value: "Case",
  label: "Case",
  factorToBase: 12,
  kind: "level",
  price: 24,
  listPrice: 24,
};
const BOX: UnitOption = {
  value: "",
  label: "Box",
  factorToBase: 24,
  kind: "pack",
  price: 48,
  listPrice: 48,
};
const PIECE: UnitOption = {
  value: "Piece",
  label: "Piece",
  factorToBase: 1,
  kind: "piece",
  price: 2,
  listPrice: 2,
};
const line = (over: Partial<InvoiceUnitFields> = {}): InvoiceUnitFields => ({
  key: "k1",
  productId: "p1",
  description: "Soda",
  qty: 51,
  boxes: 2,
  pieces: 3,
  unitsPerBox: 24,
  unitPrice: 45.5,
  unit: "Box",
  listPrice: 48,
  priceType: "MANUAL",
  priceEdited: true,
  avgCost: 30,
  tierPrices: { pricePerUnit: "48" },
  ...over,
});

describe("chooseUnit", () => {
  it("a level: qty 1, the label, the option price pre-filled, no boxes / pieces / unitsPerBox, per-unit cost", () => {
    const [it] = chooseUnit([line()], "k1", CASE, false, tier1);
    expect(it).toMatchObject({
      unitLabel: "Case",
      qty: 1,
      unitPrice: 24,
      unit: "Case",
      avgCost: 30 * 12,
      pricing: { tierPrice: 24, listPrice: 24, isSpecialTier: false },
    });
    expect(it.boxes).toBeUndefined();
    expect(it.pieces).toBeUndefined();
    expect(it.unitsPerBox).toBeUndefined();
  });

  it("M7: Box -> Case -> Box restores qty / boxes / pieces / unitPrice / priceType and the pack display exactly", () => {
    const start = line({ regularPrice: 50, isSpecialPrice: true });
    const back = chooseUnit(chooseUnit([start], "k1", CASE, false, tier1), "k1", BOX, false, tier1);
    expect(back[0]).toMatchObject({
      qty: 51,
      boxes: 2,
      pieces: 3,
      unitsPerBox: 24,
      unitPrice: 45.5,
      priceType: "MANUAL",
      regularPrice: 50,
      isSpecialPrice: true,
      sellBy: "case",
    });
    expect(back[0].unitLabel).toBeUndefined();
    expect(back[0].packBase).toBeUndefined();
  });

  it("a customer-special pack price is not re-priced to the tier price on the way back (tier columns are not applied)", () => {
    const special = line({ unitPrice: 40, priceEdited: false, priceType: "SPECIAL" });
    const back = chooseUnit(
      chooseUnit([special], "k1", CASE, false, tier3),
      "k1",
      BOX,
      false,
      tier3,
    );
    expect(back[0].unitPrice).toBe(40);
    expect(back[0].tierPrices).toEqual({ pricePerUnit: "48" });
  });

  it("D1: Piece on a boxed product stays a PACK line (box price, unitsPerBox, no unitLabel), prorated by computeLineSubtotal", () => {
    const [it] = chooseUnit([line()], "k1", PIECE, false, tier1);
    expect(it).toMatchObject({
      sellBy: "unit",
      unitsPerBox: 24,
      unitPrice: 45.5,
      pieceUnit: "Piece",
    });
    expect(it.unitLabel).toBeUndefined();
    expect(unitPayload(it)).toEqual({});
    expect(computeLineSubtotal({ unitPrice: 3, qty: 2, boxes: 0, pieces: 2, unitsPerBox: 3 })).toBe(
      2,
    );
  });

  it("Piece after a level restores the pack, then sits at {boxes 0, pieces 1, qty 1}", () => {
    const [it] = chooseUnit(
      chooseUnit([line()], "k1", CASE, false, tier1),
      "k1",
      PIECE,
      false,
      tier1,
    );
    expect(it).toMatchObject({ boxes: 0, pieces: 1, qty: 1, unitsPerBox: 24, unitPrice: 45.5 });
    expect(it.unitLabel).toBeUndefined();
  });

  it("a Piece tier refresh only moves the informational per-piece price", () => {
    const [piece] = chooseUnit([line()], "k1", PIECE, false, tier1);
    const [again] = chooseUnit([piece], "k1", { ...PIECE, price: 1.9 }, true, tier1);
    expect(again.pieceUnitPrice).toBe(1.9);
    expect(again.unitPrice).toBe(45.5);
    expect(again.qty).toBe(piece.qty);
  });

  it("a level folds into a twin line of the same product + unit by adding counts", () => {
    const a = line({ key: "a" });
    const b = line({ key: "b" });
    const onA = chooseUnit([a, b], "a", CASE, false, tier1);
    const folded = chooseUnit(onA, "b", CASE, false, tier1);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ unitLabel: "Case", qty: 2 });
  });
});

describe("pickerLineOf", () => {
  it("U7: a Piece-mode pack line is shown as 'Piece' at the Piece price; the stored line is not touched", () => {
    const [piece] = chooseUnit([line()], "k1", PIECE, false, tier1);
    expect(pickerLineOf(piece)).toMatchObject({
      unitLabel: "Piece",
      unitPrice: 2,
      unitsPerBox: 24,
    });
    expect(piece.unitPrice).toBe(45.5);
  });
  it("a Box line shows no unitLabel; a level line shows its label and unit price", () => {
    expect(pickerLineOf(line()).unitLabel).toBeUndefined();
    const [c] = chooseUnit([line()], "k1", CASE, false, tier1);
    expect(pickerLineOf(c)).toMatchObject({ unitLabel: "Case", unitPrice: 24 });
  });
});

describe("prices and payloads", () => {
  it("U2: a typed price shapes the line and survives a refresh (priceEdited, MANUAL)", () => {
    const [c] = chooseUnit([line()], "k1", CASE, false, tier1);
    const typed = withTypedPrice(c, 22.5);
    expect(typed).toMatchObject({ unitPrice: 22.5, priceEdited: true, priceType: "MANUAL" });
    expect(typed.startOnDefaultUnit).toBe(false);
  });

  it("S3: the sale basis omits unitPrice on a unit line until it is moved off the picked price", () => {
    const [c] = chooseUnit([line()], "k1", CASE, false, tier3);
    expect(saleUnitPriceField(c)).toEqual({});
    expect(saleUnitPriceField(withTypedPrice(c, 20))).toEqual({ unitPrice: 20 });
    expect(saleUnitPriceField(line())).toEqual({ unitPrice: 45.5 });
  });

  it("only a level line sends a unitLabel", () => {
    const [c] = chooseUnit([line()], "k1", CASE, false, tier1);
    expect(unitPayload(c)).toEqual({ unitLabel: "Case" });
    expect(unitProductIds([c, line({ key: "z", productId: "p2" })])).toEqual(["p1"]);
  });
});

describe("mergeIntoPackLine", () => {
  it("a default-start tap on a pending line records one more tap and leaves the quantity alone", () => {
    const pending = line({ startOnDefaultUnit: true, pendingTaps: 1, priceEdited: false });
    const next = mergeIntoPackLine(pending, undefined, true);
    expect(next.pendingTaps).toBe(2);
    expect(next.boxes).toBe(2);
  });
  it("any other add bumps a case and consumes the flag", () => {
    const next = mergeIntoPackLine(line({ priceEdited: false }), undefined, true);
    expect(next).toMatchObject({ boxes: 3, startOnDefaultUnit: false });
  });
});

describe("unitRefusalCopy", () => {
  const err = (code?: string) => ({ response: { status: 400, data: code ? { code } : {} } });
  it("S2: UNIT_NOT_OFFERED gets the coded copy; anything else is null (the generic text stays)", () => {
    expect(unitRefusalCopy(err(API_ERROR_CODES.UNIT_NOT_OFFERED))).toMatch(
      /unit isn't offered for this product/,
    );
    expect(unitRefusalCopy(err())).toBeNull();
    expect(unitRefusalCopy(null)).toBeNull();
  });
});
