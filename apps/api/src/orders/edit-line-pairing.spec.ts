import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { pairEditLines } from "./buyer-edit-lines";

/**
 * B297 row 373(b) (SA-734r2 r-note 8): ONE pairing helper for the buyer, staff and driver replace edits. A
 * re-created line is a NEW SALE only if it is unpaired or a product substitute. A paired line carries its own
 * trio and createdAt (through `sourceLineId`); added quantity at a different live trio SPLITs through foldTarget;
 * an id-less entry gets the strict fallback: exactly one match carries, two or more are 409
 * ORDER_EDIT_NEEDS_LINE_IDS, never guessed.
 */
const T1 = new Date("2026-10-01T10:00:00Z");
const stored = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  productId: "p1",
  status: "PENDING",
  qty: 12,
  boxes: null,
  pieces: null,
  unitLabel: null,
  createdAt: T1,
  trackedCategoryId: "cat-1",
  categoryTaxType: "EXCISE_PER_UNIT",
  categoryTaxRate: "0.0500",
  categoryPriceIncludesTax: false,
  ...over,
});
const product = { id: "p1", unitsPerBox: null, trackedCategoryId: "cat-1" };
const liveCat = (rate: string) =>
  new Map([["cat-1", { id: "cat-1", taxType: "EXCISE_PER_UNIT", rate, priceIncludesTax: false }]]);
const pair = (items: any[], lines: any[], rate = "0.0500", role: any = "STAFF") => {
  const dto = { items, replaceAll: true } as any;
  pairEditLines(dto, { lineItems: lines }, new Map([["p1", product]]), liveCat(rate), role, {
    buyerLineIds: true,
  });
  return dto.items as any[];
};

describe("pairEditLines (row 373b)", () => {
  it("a staff entry naming its stored line by id is paired with it", () => {
    const out = pair([{ productId: "p1", qty: 12, id: "L1" }], [stored("L1")]);
    expect(out).toHaveLength(1);
    expect(out[0].sourceLineId).toBe("L1");
  });

  it("an id-less entry with exactly ONE stored line of the product carries that line", () => {
    const out = pair([{ productId: "p1", qty: 12 }], [stored("L1")]);
    expect(out[0].sourceLineId).toBe("L1");
  });

  it("an id-less entry with TWO stored lines of the product is 409 ORDER_EDIT_NEEDS_LINE_IDS, nothing guessed", () => {
    let err: any;
    try {
      pair([{ productId: "p1", qty: 12 }], [stored("L1"), stored("L2")]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe(API_ERROR_CODES.ORDER_EDIT_NEEDS_LINE_IDS);
  });

  it("an entry with no matching stored line is a NEW sale: no sourceLineId", () => {
    const out = pair([{ productId: "p1", qty: 5 }], []);
    expect(out[0].sourceLineId).toBeUndefined();
  });

  it("a named line plus an id-less extra entry: the named one carries, the extra is a new line", () => {
    const out = pair(
      [
        { productId: "p1", qty: 12, id: "L1" },
        { productId: "p1", qty: 3 },
      ],
      [stored("L1")],
    );
    expect(out[0].sourceLineId).toBe("L1");
    expect(out[1].sourceLineId).toBeUndefined();
  });

  it("added quantity at a different LIVE trio splits: the stored qty stays on the line, the rest is a new live line", () => {
    const out = pair([{ productId: "p1", qty: 20, id: "L1" }], [stored("L1")], "0.0800");
    expect(out.map((o) => [o.qty, o.sourceLineId ?? null])).toEqual([
      [12, "L1"],
      [8, null],
    ]);
  });

  it("an entry already carrying a sourceLineId (a fold's output) is left exactly as it is", () => {
    const out = pair([{ productId: "p1", qty: 20, sourceLineId: "L1" }], [stored("L1")], "0.0800");
    expect(out).toEqual([{ productId: "p1", qty: 20, sourceLineId: "L1" }]);
  });

  it("an id that is not a live line of the order is ignored (a stale id is not a 400 for staff)", () => {
    const out = pair([{ productId: "p1", qty: 4, id: "gone" }], []);
    expect(out[0].sourceLineId).toBeUndefined();
  });

  // review fold: the split's unit and its added half
  const boxed = { id: "p1", unitsPerBox: 6, trackedCategoryId: "cat-1" };
  const pairBoxed = (items: any[], lines: any[], rate: string, role: any) => {
    const dto = { items, replaceAll: true } as any;
    pairEditLines(dto, { lineItems: lines }, new Map([["p1", boxed]]), liveCat(rate), role, {
      buyerLineIds: true,
    });
    return dto.items as any[];
  };

  it("want is read through normalizeBoxesPieces: an explicit boxes/pieces split wins over a stale qty", () => {
    // stored box-split line: 2 boxes of 6 = 12 pieces at 0.05; live rate is 0.08
    const line = stored("L1", { boxes: 2, pieces: 0, qty: 12, unitLabel: null });
    // entry says qty 12 (stale) but names 3 boxes + 0 pieces = 18 pieces: 6 added
    const out = pairBoxed(
      [{ productId: "p1", id: "L1", qty: 12, boxes: 3, pieces: 0 }],
      [line],
      "0.0800",
      "STAFF",
    );
    expect(out).toHaveLength(2);
    expect(out[1].sourceLineId).toBeUndefined();
    expect(out[1].qty).toBe(6);
  });

  it("DRIVER with a pack line AND a box-split line: the added half is written in the unit the write path reads (pieces)", () => {
    const pack = stored("A", { qty: 2 }); // pack line: 2 selling units
    const boxSplit = stored("B", { boxes: 1, pieces: 0, qty: 6 });
    const out = pairBoxed(
      [{ productId: "p1", id: "A", qty: 3 }],
      [pack, boxSplit],
      "0.0800",
      "DRIVER",
    );
    // the carried half stays 2 packs on A; the 1 added pack is read by the product-wide gate (a box-split line
    // exists): 1 pack = 6 pieces, so it is written as qty 6, never as 1 piece
    expect(out.map((o) => [o.qty, o.sourceLineId ?? null])).toEqual([
      [2, "A"],
      [6, null],
    ]);
  });

  it("a STAFF entry with a plain or zero split is selling units: a box-split stored line is compared in boxes", () => {
    // stored: 2 boxes of 6 = 12 pieces (qty 12). The entry says 20 PACKS (a zero split is "not using box entry").
    const line = stored("L1", { boxes: 2, pieces: 0, qty: 12 });
    const out = pairBoxed(
      [{ productId: "p1", id: "L1", qty: 20, boxes: 0, pieces: 0 }],
      [line],
      "0.0800",
      "STAFF",
    );
    // have = 12 pieces (2 boxes), want = 20 packs = 120 pieces: written as explicit splits in PIECES, 12 stay
    // on the line and 108 (18 packs) go to the new live line; no fractional pack count is ever written
    expect(out.map((o) => o.qty)).toEqual([12, 108]);
  });

  it("STAFF plain entry on a box-split line WITH loose pieces: both halves are explicit splits in pieces, no fractional pack", () => {
    // stored 14 pieces = 2 boxes + 2 pieces (upb 6). The staff entry says 3 packs (18 pieces) at a new trio.
    const line = stored("L1", { boxes: 2, pieces: 2, qty: 14 });
    const out = pairBoxed([{ productId: "p1", id: "L1", qty: 3 }], [line], "0.0800", "STAFF");
    expect(out).toHaveLength(2);
    // carried half keeps exactly the stored 14 pieces (2 boxes + 2 pieces); the added half is 4 pieces
    expect(out.map((o) => [o.qty, o.boxes, o.pieces])).toEqual([
      [14, 2, 2],
      [4, 0, 4],
    ]);
  });

  it("a DRIVER ignores its own boxes/pieces: a paired pack line is read like itself", () => {
    const pack = stored("A", { qty: 2 });
    const out = pairBoxed(
      [{ productId: "p1", id: "A", qty: 5, boxes: 5 }],
      [pack],
      "0.0800",
      "DRIVER",
    );
    // no box-split line of the product exists: the gate is selling units; 5 packs vs 2 stored: 3 added
    expect(out.map((o) => o.qty)).toEqual([2, 3]);
  });

  it("a DRIVER whose gate is pieces ONLY because of a CANCELLED box-split line still writes the added pack as pieces", () => {
    const pack = stored("A", { qty: 2 });
    const cancelled = stored("C", { boxes: 1, pieces: 0, qty: 6, status: "CANCELLED" });
    const out = pairBoxed(
      [{ productId: "p1", id: "A", qty: 3 }],
      [pack, cancelled],
      "0.0800",
      "DRIVER",
    );
    expect(out.map((o) => [o.qty, o.sourceLineId ?? null])).toEqual([
      [2, "A"],
      [6, null],
    ]);
  });

  it("a DRIVER fractional pack count makes no split (never a truncated piece count)", () => {
    const pack = stored("A", { qty: 2 });
    const boxSplit = stored("B", { boxes: 1, pieces: 0, qty: 6 });
    const out = pairBoxed(
      [{ productId: "p1", id: "A", qty: 2.1 }],
      [pack, boxSplit],
      "0.0800",
      "DRIVER",
    );
    expect(out).toHaveLength(1);
    expect(out[0].qty).toBe(2.1);
  });

  it("STAFF 2.4 packs on a 14-piece box-split line is left whole (no truncated, empty added half)", () => {
    const line = stored("L1", { boxes: 2, pieces: 2, qty: 14 });
    const out = pairBoxed([{ productId: "p1", id: "L1", qty: 2.4 }], [line], "0.0800", "STAFF");
    expect(out).toHaveLength(1);
    expect(out[0].qty).toBe(2.4);
  });

  it("a stored FRACTIONAL pack line with a real staff split is left whole (7.5 pieces never truncated to 7)", () => {
    const line = stored("L1", { qty: 1.5 }); // 1.5 packs of upb 6 = 9 pieces? held fractional on purpose
    const dto = { items: [{ productId: "p1", id: "L1", qty: 10, boxes: 1, pieces: 4 }] } as any;
    pairEditLines(
      dto,
      { lineItems: [line] },
      new Map([["p1", { id: "p1", unitsPerBox: 5, trackedCategoryId: "cat-1" }]]),
      liveCat("0.0800"),
      "STAFF",
      { buyerLineIds: true },
    );
    expect(dto.items).toHaveLength(1);
  });

  it("a DRIVER 3.3 packs vs 1.1 stored (upb 10) is a whole 22 pieces, not float noise that blocks the split", () => {
    const boxed10 = { id: "p1", unitsPerBox: 10, trackedCategoryId: "cat-1" };
    const pack = stored("A", { qty: 1.1 });
    const boxSplit = stored("B", { boxes: 1, pieces: 0, qty: 10 });
    const dto = { items: [{ productId: "p1", id: "A", qty: 3.3 }] } as any;
    pairEditLines(
      dto,
      { lineItems: [pack, boxSplit] },
      new Map([["p1", boxed10]]),
      liveCat("0.0800"),
      "DRIVER",
      { buyerLineIds: true },
    );
    expect(dto.items).toHaveLength(2);
    expect(dto.items[1].qty).toBe(22);
  });

  it("a BUYER zero split on a pack line is read as the write reads it (pieces): nothing added, no split", () => {
    const pack = stored("A", { qty: 2 }); // 2 packs of 12 pieces
    const dto = {
      items: [{ productId: "p1", orderItemId: "A", qty: 24, boxes: 0, pieces: 0 }],
    } as any;
    pairEditLines(
      dto,
      { lineItems: [pack] },
      new Map([["p1", { id: "p1", unitsPerBox: 12, trackedCategoryId: "cat-1" }]]),
      liveCat("0.0800"),
      "BUYER",
      { buyerLineIds: true },
    );
    expect(dto.items).toHaveLength(1); // 24 pieces == 2 packs: no quantity was added
  });

  it("the added half drops a price that only ECHOES the stored line; a CHANGED price stays on both halves", () => {
    const line = stored("L1", { unitPrice: 7, overrideReason: "agreed price" });
    const echo = pair(
      [{ productId: "p1", id: "L1", qty: 20, unitPrice: 7, overrideReason: "agreed price" }],
      [line],
      "0.0800",
    );
    expect(echo).toHaveLength(2);
    expect(echo[0].unitPrice).toBe(7);
    expect(echo[1].unitPrice).toBeUndefined();
    expect(echo[1].overrideReason).toBeUndefined();
    const changed = pair(
      [{ productId: "p1", id: "L1", qty: 20, unitPrice: 8, overrideReason: "new deal" }],
      [line],
      "0.0800",
    );
    expect(changed.map((o) => [o.unitPrice, o.overrideReason])).toEqual([
      [8, "new deal"],
      [8, "new deal"],
    ]);
  });

  it("a paired entry carries its stored line's category, trio and createdAt for builders that cannot read sourceLineId", () => {
    const out = pair([{ productId: "p1", id: "L1", qty: 12 }], [stored("L1")]);
    expect(out[0].carriedLine).toMatchObject({
      trackedCategoryId: "cat-1",
      categoryTaxType: "EXCISE_PER_UNIT",
      createdAt: T1,
    });
  });
});
