import { computeLineSubtotal } from "@routeflow/pricing";
import {
  addCatalogItem,
  buyerEditPriceText,
  buyerSavePlan,
  draftCount,
  draftMax,
  hydrateBuyerDraft,
  restoreDraftRow,
  setDraftCount,
  stepDraftCount,
  type BuyerOrderLineLike,
} from "../lib/buyer-edit-items";

/**
 * REG-B1395 (SA-1292): the customer edit-items grid showed a stored 3-box line (12 a box, $18.00 a box) as 36, and its
 * "+" sent 37 pieces ($55.50). It now counts, steps, types and clamps in the line's SELLING unit through the one
 * pricing helper; the wire stays pieces. The screen is not renderable here, so its pure half is exercised (the
 * screen's source wiring is pinned in buyer-edit-items-remove-readd and the digits pin). Placeholders only.
 */
const BOX_LINE: BuyerOrderLineLike = {
  id: "li-1",
  productId: "p-1",
  qty: 36,
  unitPrice: 18,
  boxes: 3,
  pieces: 0,
  unitsPerBox: 12,
  status: "PENDING",
  product: { name: "Sample Cola 12oz", unit: "can", unitsPerBox: 12 },
};

const line = (over: Partial<BuyerOrderLineLike> = {}): BuyerOrderLineLike => ({
  ...BOX_LINE,
  ...over,
});

/** The money for a split line at `qty` pieces, as the order total prices it. */
const money = (qty: number) =>
  computeLineSubtotal({
    unitPrice: 18,
    qty,
    boxes: Math.floor(qty / 12),
    pieces: qty % 12,
    unitsPerBox: 12,
  });

const open = (l: BuyerOrderLineLike) => hydrateBuyerDraft([l]);

describe("REG-B1395 mobile edit-items counts the selling unit", () => {
  it("hydrate: a stored 3-box line shows a count of 3 (it showed 36), and keeps 36 pieces on the wire", () => {
    const d = open(line());
    expect(draftCount(d["li-1"])).toBe(3);
    expect(d["li-1"].qty).toBe(36);
    expect(d["li-1"].editUnit).toBe("CASE");
  });

  it('"+" adds one box: 48 pieces, $72.00 (it sent 37, $55.50)', () => {
    const edit = stepDraftCount(open(line()), "li-1", 1);
    expect(edit.draft["li-1"].qty).toBe(48);
    expect(draftCount(edit.draft["li-1"])).toBe(4);
    expect(money(48)).toBe(72);
    expect(edit.limit).toBeNull();
  });

  it('"-" takes one box off: 24 pieces', () => {
    expect(stepDraftCount(open(line()), "li-1", -1).draft["li-1"].qty).toBe(24);
  });

  it("a typed 2 is 2 boxes (24 pieces) and a typed 4 is 4 boxes (48)", () => {
    expect(setDraftCount(open(line()), "li-1", 2).draft["li-1"].qty).toBe(24);
    expect(setDraftCount(open(line()), "li-1", 4).draft["li-1"].qty).toBe(48);
  });

  it("re-adding the product from the catalog adds one box: 48 (it added one piece: 37)", () => {
    const d = addCatalogItem(open(line()), {
      id: "p-1",
      name: "Sample Cola 12oz",
      unit: "can",
      buyerPrice: 18,
      unitsPerBox: 12,
    });
    expect(d["li-1"].qty).toBe(48);
    expect(Object.keys(d)).toEqual(["li-1"]);
  });

  it("the unit holds for the edit session: a count never flips a box row to pieces", () => {
    let d = open(line());
    d = setDraftCount(d, "li-1", 5).draft;
    d = stepDraftCount(d, "li-1", 1).draft;
    expect(d["li-1"].editUnit).toBe("CASE");
    expect(d["li-1"].qty).toBe(72);
  });

  it("the bound is 8,333 boxes at 12 a box; a typed count past it stays at it and says so", () => {
    const d = open(line());
    expect(draftMax(d["li-1"])).toBe(8333);
    const edit = setDraftCount(d, "li-1", 9000);
    expect(edit.draft["li-1"].qty).toBe(99_996);
    expect(edit.limit).toBe("The most you can order at once is 8,333 boxes.");
  });

  it('"+" at the bound stays at 8,333 boxes and returns the limit line', () => {
    const atMax = setDraftCount(open(line()), "li-1", 8333).draft;
    const edit = stepDraftCount(atMax, "li-1", 1);
    expect(edit.draft["li-1"].qty).toBe(99_996);
    expect(edit.limit).toBe("The most you can order at once is 8,333 boxes.");
  });

  it("the limit line names the product's pack word: a case product says cases", () => {
    const d = open(line({ product: { name: "Sample Cola", unit: "case", unitsPerBox: 12 } }));
    expect(setDraftCount(d, "li-1", 9000).limit).toBe(
      "The most you can order at once is 8,333 cases.",
    );
  });

  it('"-" at one box removes the row and hands it back for Undo (SA-1283 part 2)', () => {
    const one = open(line({ qty: 12, boxes: 1 }));
    const edit = stepDraftCount(one, "li-1", -1);
    expect(edit.draft).toEqual({});
    expect(edit.removed).toMatchObject({ orderItemId: "li-1", qty: 12, name: "Sample Cola 12oz" });
    expect(restoreDraftRow(edit.draft, edit.removed!)).toEqual(one);
  });

  it("a typed 0 removes the row the same way", () => {
    const edit = setDraftCount(open(line()), "li-1", 0);
    expect(edit.draft).toEqual({});
    expect(edit.removed?.orderItemId).toBe("li-1");
  });

  it("Undo after the product was added back joins the counts, clamped (3 boxes + 1 new box = 4)", () => {
    const removed = setDraftCount(open(line()), "li-1", 0);
    const readded = addCatalogItem(removed.draft, {
      id: "p-1",
      name: "Sample Cola 12oz",
      unit: "can",
      buyerPrice: 18,
      unitsPerBox: 12,
    });
    expect(readded["p-1"]).toMatchObject({ qty: 1, editUnit: "PACK" });
    // a different key, so the removed row comes back beside it (the server reads each line by its own id)
    expect(Object.keys(restoreDraftRow(readded, removed.removed!)).sort()).toEqual(["li-1", "p-1"]);
    // the same key held again: the counts join and clamp to the bound
    const held = setDraftCount(open(line()), "li-1", 8333).draft;
    const joined = restoreDraftRow(held, open(line())["li-1"]);
    expect(joined["li-1"].qty).toBe(99_996);
  });

  it("the save plan sends the CASE row at 4 boxes as { productId, qty: 48, orderItemId } and nothing else", () => {
    const d = stepDraftCount(open(line()), "li-1", 1).draft;
    expect(buyerSavePlan([line()], d)).toEqual({
      kind: "replace",
      items: [{ productId: "p-1", qty: 48, orderItemId: "li-1" }],
    });
  });

  it("an untouched box row saves its own 36 pieces", () => {
    expect(buyerSavePlan([line()], open(line()))).toEqual({
      kind: "replace",
      items: [{ productId: "p-1", qty: 36, orderItemId: "li-1" }],
    });
  });
});

describe("REG-B1395 greens: rows that are not a whole-box line keep stepping their own unit", () => {
  it("a pack row (stored in packs) at 2, plus: 3", () => {
    const d = open(line({ qty: 2, boxes: null, pieces: null, unitsPerBox: null }));
    expect(d["li-1"].editUnit).toBe("PACK");
    expect(draftCount(d["li-1"])).toBe(2);
    expect(stepDraftCount(d, "li-1", 1).draft["li-1"].qty).toBe(3);
  });

  it("a new catalog row is a pack row: 1, then plus: 2, no line id", () => {
    const d = addCatalogItem(
      {},
      { id: "p-9", name: "Sample Soda", unit: "each", buyerPrice: 5, unitsPerBox: null },
    );
    expect(d["p-9"]).not.toHaveProperty("orderItemId");
    expect(stepDraftCount(d, "p-9", 1).draft["p-9"].qty).toBe(2);
  });

  it("a repacked row (stored 12, live 6) at 36, plus: 37 pieces", () => {
    const d = open(line({ product: { name: "Sample Cola", unit: "can", unitsPerBox: 6 } }));
    expect(d["li-1"].editUnit).toBe("PIECE");
    expect(draftCount(d["li-1"])).toBe(36);
    expect(stepDraftCount(d, "li-1", 1).draft["li-1"].qty).toBe(37);
  });

  it("a loose-piece row (38) at plus: 39 pieces", () => {
    const d = open(line({ qty: 38, boxes: 3, pieces: 2 }));
    expect(d["li-1"].editUnit).toBe("PIECE");
    expect(stepDraftCount(d, "li-1", 1).draft["li-1"].qty).toBe(39);
  });

  it("a line whose product pack is not on the wire counts pieces, never a guessed box", () => {
    const d = open(line({ product: { name: "Sample Cola", unit: "can" } }));
    expect(d["li-1"].editUnit).toBe("PIECE");
    expect(stepDraftCount(d, "li-1", 1).draft["li-1"].qty).toBe(37);
  });

  it("a units_v1 unit line stays read-only: its count is the stored COUNT, never boxes of boxes", () => {
    const d = open(line({ unitLabel: "Case", qty: 36, boxes: 3 }));
    expect(d["li-1"]).toMatchObject({ qty: 3, editUnit: "PACK" });
  });
});

describe("REG-B1395 the price line reads through pricedPerLabel (SA NOTE 7170635163)", () => {
  it('a box line of cans reads "$18.00 per box (12 cans)" (it read "$18.00 / can")', () => {
    expect(buyerEditPriceText(open(line())["li-1"])).toBe("$18.00 per box (12 cans)");
  });

  it('a case product reads "per case (12 pieces)"', () => {
    expect(buyerEditPriceText({ unitPrice: 18, unit: "case", unitsPerBox: 12 })).toBe(
      "$18.00 per case (12 pieces)",
    );
  });

  it("an each product with no pack reads each, and a row with no unit reads the money alone", () => {
    expect(buyerEditPriceText({ unitPrice: 5, unit: "each", unitsPerBox: null })).toBe(
      "$5.00 each",
    );
    expect(buyerEditPriceText({ unitPrice: 5 })).toBe("$5.00");
  });

  it("a units_v1 line keeps its own unit's name (#2222)", () => {
    expect(buyerEditPriceText({ unitPrice: 65, unit: "can", unitLabel: "Case" })).toBe(
      "$65.00 / Case",
    );
  });
});
