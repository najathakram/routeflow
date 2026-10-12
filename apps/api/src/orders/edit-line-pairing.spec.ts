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

  it("a DRIVER entry is denominated by the product-wide gate, not its own boxes/pieces", () => {
    // 2 packs stored as a box-unaware line (qty 2 selling units); the entry sends qty 5 + boxes 5 (a pack count).
    // The write path reads a driver's qty by the PRODUCT gate (no box-split line stored => selling units): 5 > 2.
    const line = stored("L1", { qty: 2 });
    const out = pairBoxed(
      [{ productId: "p1", id: "L1", qty: 5, boxes: 5 }],
      [line],
      "0.0800",
      "DRIVER",
    );
    expect(out).toHaveLength(2);
    expect(out[1].qty).toBe(3);
  });

  it("the split's added half keeps the stored line's override reason when the entry echoes its price", () => {
    const line = stored("L1", { unitPrice: 7, overrideReason: "agreed price" });
    const out = pair([{ productId: "p1", id: "L1", qty: 20, unitPrice: 7 }], [line], "0.0800");
    expect(out).toHaveLength(2);
    expect(out[1].overrideReason).toBe("agreed price");
    // a DIFFERENT price is a new decision: the reason is not borrowed
    const other = pair([{ productId: "p1", id: "L1", qty: 20, unitPrice: 9 }], [line], "0.0800");
    expect(other[1].overrideReason).toBeUndefined();
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
