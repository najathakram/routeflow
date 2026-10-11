import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  BUYER_EDIT_IDLESS_FALLBACK,
  applyBuyerEditLines,
  assertNoOrderItemIdOutsideBuyerEdit,
  preflightBuyerEditLines,
  resolveBuyerEditLines,
  type StoredEditLine,
} from "./buyer-edit-lines";

/**
 * B297 row 352 (SA-734r2 r-note 4): the buyer's items edit names its lines. A named line keeps its own rate
 * trio; more quantity at a trio that differs from today's goes on a new live line; an id off this order is
 * a 400; an id-less entry is a new line, or (one release) the line of its product when exactly one exists,
 * and 409 ORDER_EDIT_NEEDS_LINE_IDS when two or more could be meant.
 */
const T = (rate: number, over: Record<string, unknown> = {}) => ({
  trackedCategoryId: "cat-1",
  categoryTaxType: "EXCISE_PER_UNIT",
  categoryTaxRate: rate,
  categoryPriceIncludesTax: false,
  ...over,
});
const line = (id: string, rate: number, over: Partial<StoredEditLine> = {}): StoredEditLine => ({
  id,
  productId: "p1",
  status: "PENDING",
  qty: 12,
  boxes: null,
  pieces: null,
  unitLabel: null,
  ...T(rate),
  ...over,
});
const live = new Map([["p1", T(0.07)]]);
const upb = new Map([["p1", 12]]);
const run = (items: any[], lineItems: StoredEditLine[], extra: Record<string, unknown> = {}) =>
  resolveBuyerEditLines({
    items,
    lineItems,
    liveTrioByProduct: live,
    upbByProduct: upb,
    ...extra,
  });

describe("resolveBuyerEditLines", () => {
  it("a named line is carried through sourceLineId and orderItemId is dropped", () => {
    const [a] = run([{ productId: "p1", qty: 12, orderItemId: "L1" }], [line("L1", 0.05)]);
    expect(a).toMatchObject({ productId: "p1", qty: 12, sourceLineId: "L1" });
    expect(a).not.toHaveProperty("orderItemId");
  });

  it("two lines of one product each resolve to their own line (the round trip after a split)", () => {
    const out = run(
      [
        { productId: "p1", qty: 12, orderItemId: "L1" },
        { productId: "p1", qty: 8, orderItemId: "L2" },
      ],
      [line("L1", 0.05), line("L2", 0.07, { qty: 8 })],
    );
    expect(out.map((i) => [i.sourceLineId, i.qty])).toEqual([
      ["L1", 12],
      ["L2", 8],
    ]);
  });

  it("more qty at a trio that differs from today's keeps the stored qty on the line and adds a live line", () => {
    const out = run([{ productId: "p1", qty: 20, orderItemId: "L1" }], [line("L1", 0.05)]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ qty: 12, sourceLineId: "L1" });
    expect(out[1]).toMatchObject({ qty: 8 });
    expect(out[1]).not.toHaveProperty("sourceLineId");
  });

  it("more qty at the SAME trio stays on the one line", () => {
    const out = run([{ productId: "p1", qty: 20, orderItemId: "L1" }], [line("L1", 0.07)]);
    expect(out).toEqual([expect.objectContaining({ qty: 20, sourceLineId: "L1" })]);
  });

  it("fewer or equal qty keeps the line at its own trio even when today's differs", () => {
    const out = run([{ productId: "p1", qty: 6, orderItemId: "L1" }], [line("L1", 0.05)]);
    expect(out).toEqual([expect.objectContaining({ qty: 6, sourceLineId: "L1" })]);
  });

  it("an explicit box split is compared in pieces and the split halves keep a box split", () => {
    const stored = line("L1", 0.05, { qty: 24, boxes: 2, pieces: 0 });
    const out = run(
      [{ productId: "p1", qty: 30, boxes: 2, pieces: 6, orderItemId: "L1" }],
      [stored],
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ qty: 24, boxes: 2, pieces: 0, sourceLineId: "L1" });
    expect(out[1]).toMatchObject({ qty: 6, boxes: 0, pieces: 6 });
  });

  it("a bare qty on a box-split line is pieces: compared with the stored pieces", () => {
    const stored = line("L1", 0.05, { qty: 24, boxes: 2, pieces: 0 });
    const out = run([{ productId: "p1", qty: 30, orderItemId: "L1" }], [stored]);
    expect(out.map((i) => i.qty)).toEqual([24, 6]);
  });

  it("an id that is not a line of this order is a 400, never a silent new line", () => {
    expect(() =>
      run([{ productId: "p1", qty: 1, orderItemId: "OTHER" }], [line("L1", 0.05)]),
    ).toThrow(BadRequestException);
  });

  it("the id of a CANCELLED line is not a line of this order", () => {
    expect(() =>
      run(
        [{ productId: "p1", qty: 1, orderItemId: "L1" }],
        [line("L1", 0.05, { status: "CANCELLED" })],
      ),
    ).toThrow(BadRequestException);
  });

  it("an id of another product is a 400", () => {
    expect(() => run([{ productId: "p2", qty: 1, orderItemId: "L1" }], [line("L1", 0.05)])).toThrow(
      BadRequestException,
    );
  });

  it("the same id twice is a 400", () => {
    expect(() =>
      run(
        [
          { productId: "p1", qty: 1, orderItemId: "L1" },
          { productId: "p1", qty: 2, orderItemId: "L1" },
        ],
        [line("L1", 0.05)],
      ),
    ).toThrow(BadRequestException);
  });

  it("an id-less entry for a product with no line is a new line", () => {
    const out = run([{ productId: "p2", qty: 3 }], [line("L1", 0.05)]);
    expect(out).toEqual([{ productId: "p2", qty: 3 }]);
  });

  describe("legacy fallback (id-less)", () => {
    it("exactly one line of the product: that line, its trio carried", () => {
      const out = run([{ productId: "p1", qty: 12 }], [line("L1", 0.05)]);
      expect(out).toEqual([expect.objectContaining({ sourceLineId: "L1", qty: 12 })]);
    });

    it("two lines of the product: 409 ORDER_EDIT_NEEDS_LINE_IDS", () => {
      let err: any;
      try {
        run([{ productId: "p1", qty: 12 }], [line("L1", 0.05), line("L2", 0.07)]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "ORDER_EDIT_NEEDS_LINE_IDS" });
    });

    it("a line already named by another entry is not a candidate: the id-less entry is new", () => {
      const out = run(
        [
          { productId: "p1", qty: 12, orderItemId: "L1" },
          { productId: "p1", qty: 2 },
        ],
        [line("L1", 0.05)],
      );
      expect(out[0]).toMatchObject({ sourceLineId: "L1" });
      expect(out[1]).toEqual({ productId: "p1", qty: 2 });
    });

    it("one line but two id-less entries for the product is ambiguous: 409", () => {
      expect(() =>
        run(
          [
            { productId: "p1", qty: 1 },
            { productId: "p1", qty: 2 },
          ],
          [line("L1", 0.05)],
        ),
      ).toThrow(ConflictException);
    });

    it("a different unit is a different line", () => {
      const out = run([{ productId: "p1", qty: 1, unitLabel: "Case" }], [line("L1", 0.05)]);
      expect(out).toEqual([{ productId: "p1", qty: 1, unitLabel: "Case" }]);
    });

    it("with the fallback off an id-less entry is always a new line", () => {
      const out = run([{ productId: "p1", qty: 12 }], [line("L1", 0.05)], {
        allowIdlessFallback: false,
      });
      expect(out).toEqual([{ productId: "p1", qty: 12 }]);
    });

    it("the fallback is on for this release (flipping it is a deliberate, dated change)", () => {
      expect(BUYER_EDIT_IDLESS_FALLBACK).toBe(true);
    });
  });

  it("an entry with no product (an unlisted line) passes through untouched", () => {
    const entry = { name: "Custom", qty: 1 };
    expect(run([entry], [line("L1", 0.05)])).toEqual([entry]);
  });
});

describe("payload denomination follows the product, as the write path does", () => {
  const box = (id: string, rate: number, qty: number, over: Partial<StoredEditLine> = {}) =>
    line(id, rate, { qty, boxes: Math.floor(qty / 12), pieces: qty % 12, ...over });

  it("a plain qty on a product with a box-split line is PIECES, so a pack line beside it is expanded", () => {
    // L1 holds 2 packs (box-unaware, qty 2); L2 is box-split 12 pieces. A plain qty of 24 on L1 is 24
    // PIECES to the write path, so the stored 2 packs are 24 pieces: equal, no split.
    const out = run(
      [
        { productId: "p1", qty: 24, orderItemId: "L1" },
        { productId: "p1", qty: 12, orderItemId: "L2" },
      ],
      [line("L1", 0.05, { qty: 2 }), box("L2", 0.07, 12)],
    );
    expect(out.map((i) => [i.sourceLineId, i.qty])).toEqual([
      ["L1", 24],
      ["L2", 12],
    ]);
  });

  it("with no box-split line a plain qty is selling units, compared as stored", () => {
    const out = run(
      [{ productId: "p1", qty: 3, orderItemId: "L1" }],
      [line("L1", 0.05, { qty: 2 })],
    );
    expect(out).toHaveLength(2); // 2 stored, 1 more packs at a differing trio => split
    expect(out.map((i) => i.qty)).toEqual([2, 1]);
  });
});

describe("refusals can run before anything commits (preflight)", () => {
  it("throws the same refusals and returns nothing", () => {
    expect(() =>
      preflightBuyerEditLines(
        [{ productId: "p1", qty: 1, orderItemId: "NOPE" }],
        [line("L1", 0.05)],
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      preflightBuyerEditLines([{ productId: "p1", qty: 1 }], [line("L1", 0.05), line("L2", 0.07)]),
    ).toThrow(ConflictException);
    expect(
      preflightBuyerEditLines([{ productId: "p1", qty: 1, orderItemId: "L1" }], [line("L1", 0.05)]),
    ).toBeUndefined();
  });

  it("does not mutate the payload", () => {
    const items = [{ productId: "p1", qty: 20, orderItemId: "L1" }];
    preflightBuyerEditLines(items, [line("L1", 0.05)]);
    expect(items).toEqual([{ productId: "p1", qty: 20, orderItemId: "L1" }]);
  });

  it("namesLines turns the id-less fallback off: no 409, the entry is new", () => {
    expect(() =>
      preflightBuyerEditLines(
        [{ productId: "p1", qty: 1 }],
        [line("L1", 0.05), line("L2", 0.07)],
        true,
      ),
    ).not.toThrow();
  });
});

describe("orderItemId is refused anywhere but the buyer's items edit", () => {
  it("400s an entry that carries one, passes entries without", () => {
    expect(() =>
      assertNoOrderItemIdOutsideBuyerEdit([{ productId: "p1", orderItemId: "L1" }]),
    ).toThrow(BadRequestException);
    expect(() => assertNoOrderItemIdOutsideBuyerEdit([{ productId: "p1", qty: 1 }])).not.toThrow();
  });
});

describe("applyBuyerEditLines", () => {
  it("rewrites the array in place from the branch's product and category maps", () => {
    const items: any[] = [{ productId: "p1", qty: 20, orderItemId: "L1" }];
    const same = items;
    applyBuyerEditLines(
      { items },
      [line("L1", 0.05)],
      new Map([["p1", { id: "p1", trackedCategoryId: "cat-1", unitsPerBox: 12 }]]),
      new Map([["cat-1", { taxType: "EXCISE_PER_UNIT", rate: "0.0700", priceIncludesTax: false }]]),
    );
    expect(items).toBe(same);
    expect(items.map((i) => [i.sourceLineId ?? null, i.qty])).toEqual([
      ["L1", 12],
      [null, 8],
    ]);
  });

  it("namesLines makes an id-less entry a new line even beside exactly one line of the product", () => {
    const items: any[] = [{ productId: "p1", qty: 5 }];
    applyBuyerEditLines(
      { items, namesLines: true },
      [line("L1", 0.05)],
      new Map([["p1", { id: "p1", trackedCategoryId: "cat-1", unitsPerBox: 12 }]]),
      new Map([["cat-1", { taxType: "EXCISE_PER_UNIT", rate: "0.0700", priceIncludesTax: false }]]),
    );
    expect(items).toEqual([{ productId: "p1", qty: 5 }]);
  });
});
