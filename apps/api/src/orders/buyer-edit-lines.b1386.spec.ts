import { API_ERROR_CODES } from "../common/api-error-codes";
import { BUYER_LINE_QTY_OVER_MAX_MESSAGE } from "./buyer-line-cap";
import { pairEditLines, resolveBuyerEditLines, type StoredEditLine } from "./buyer-edit-lines";

/**
 * B1386: a buyer line quantity above BUYER_LINE_QTY_MAX (100,000 PIECES) is refused on the buyer's items edit,
 * as the create path already does. The cap is on the line's resolved piece total and is rise-only: a line that
 * already holds more than the cap may be resent unchanged or lowered.
 */
const OVER = {
  response: {
    code: API_ERROR_CODES.BUYER_LINE_QTY_OVER_MAX,
    message: BUYER_LINE_QTY_OVER_MAX_MESSAGE,
  },
};

const stored = (id: string, over: Partial<StoredEditLine> = {}): StoredEditLine => ({
  id,
  productId: "p1",
  status: "PENDING",
  qty: 10,
  boxes: null,
  pieces: null,
  unitLabel: null,
  trackedCategoryId: null,
  ...over,
});
const productMap = (upb: number, extra: Record<string, unknown> = {}) =>
  new Map<string, any>([["p1", { id: "p1", unitsPerBox: upb, trackedCategoryId: null, ...extra }]]);
const noCats = new Map<string, any>();

const buyerEdit = (
  items: any[],
  lineItems: StoredEditLine[],
  upb: number,
  opts: { cats?: Map<string, any>; product?: Map<string, any> } = {},
) =>
  pairEditLines(
    { items, namesLines: true },
    { lineItems },
    opts.product ?? productMap(upb),
    opts.cats ?? noCats,
    { role: "CUSTOMER" },
    { buyerLineIds: true },
  );

const catchErr = (fn: () => void): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};
const expectRefused = (fn: () => void) => {
  const err = catchErr(fn);
  expect(err).toBeDefined();
  expect(err).toMatchObject(OVER);
};

describe("REG-B1386 buyer edit cap", () => {
  it("E1 refuses 100,001 pieces on a plain line and leaves dto.items untouched", () => {
    const dto = { items: [{ productId: "p1", qty: 100_001, orderItemId: "L1" }], namesLines: true };
    const before = JSON.parse(JSON.stringify(dto.items));
    const first = dto.items[0];
    expectRefused(() =>
      pairEditLines(
        dto,
        { lineItems: [stored("L1", { qty: 10 })] },
        productMap(1),
        noCats,
        { role: "CUSTOMER" },
        { buyerLineIds: true },
      ),
    );
    expect(dto.items).toEqual(before);
    expect(dto.items[0]).toBe(first);
    expectRefused(() =>
      buyerEdit(
        [{ productId: "p1", qty: 100_001, orderItemId: "L1" }],
        [stored("L1", { qty: 10 })],
        1,
      ),
    );
    expectRefused(() =>
      buyerEdit(
        [{ productId: "p1", qty: 100_001, orderItemId: "L1" }],
        [stored("L1", { qty: 10 })],
        0,
      ),
    );
  });

  it("E2 refuses a pack count whose pieces pass the cap (8,334 x 12 on a non-split line)", () => {
    expectRefused(() =>
      buyerEdit(
        [{ productId: "p1", qty: 8_334, orderItemId: "L1" }],
        [stored("L1", { qty: 10 })],
        12,
      ),
    );
  });

  it("E3 refuses 100,001 pieces on a box-split line", () => {
    expectRefused(() =>
      buyerEdit(
        [{ productId: "p1", qty: 100_001, orderItemId: "L1" }],
        [stored("L1", { qty: 24, boxes: 2, pieces: 0 })],
        12,
      ),
    );
  });

  it("E4 refuses a fractional quantity just over the cap", () => {
    expectRefused(() =>
      buyerEdit(
        [{ productId: "p1", qty: 100_000.001, orderItemId: "L1" }],
        [stored("L1", { qty: 10 })],
        0,
      ),
    );
  });

  it("E5 refuses a rise that would SPLIT into a kept half plus a new half", () => {
    const cats = new Map<string, any>([
      ["cat-1", { taxType: "EXCISE_PER_UNIT", rate: 0.07, priceIncludesTax: false }],
    ]);
    const product = productMap(0, { trackedCategoryId: "cat-1" });
    const line = stored("L1", {
      qty: 90_000,
      trackedCategoryId: "cat-1",
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryTaxRate: 0.05,
      categoryPriceIncludesTax: false,
    });
    // the fixture really splits: without the cap the entry resolves to a kept half plus a new half
    const split = resolveBuyerEditLines({
      items: [{ productId: "p1", qty: 110_000, orderItemId: "L1" }],
      lineItems: [line],
      liveTrioByProduct: new Map([
        [
          "p1",
          {
            trackedCategoryId: "cat-1",
            categoryTaxType: "EXCISE_PER_UNIT",
            categoryTaxRate: 0.07,
            categoryPriceIncludesTax: false,
          },
        ],
      ]),
      upbByProduct: new Map([["p1", 0]]),
      allowIdlessFallback: false,
      role: "BUYER",
    });
    expect(split).toHaveLength(2);
    expectRefused(() =>
      buyerEdit([{ productId: "p1", qty: 110_000, orderItemId: "L1" }], [line], 0, {
        cats,
        product,
      }),
    );
  });

  it("E8 refuses an id-less legacy entry (namesLines false) that the fallback pairs with its one line", () => {
    expectRefused(() =>
      pairEditLines(
        { items: [{ productId: "p1", qty: 100_001 }], namesLines: false },
        { lineItems: [stored("L1", { qty: 10 })] },
        productMap(0),
        noCats,
        { role: "CUSTOMER" },
        { buyerLineIds: true },
      ),
    );
  });

  it("E6 refuses a NEW line of 100,001 on a plain product", () => {
    expectRefused(() =>
      buyerEdit(
        [
          { productId: "p1", qty: 10, orderItemId: "L1" },
          { productId: "p2", qty: 100_001 },
        ],
        [stored("L1", { qty: 10 })],
        0,
        {
          product: new Map<string, any>([
            ["p1", { id: "p1", unitsPerBox: 0, trackedCategoryId: null }],
            ["p2", { id: "p2", unitsPerBox: 0, trackedCategoryId: null }],
          ]),
        },
      ),
    );
  });
});

describe("buyer edit cap pins (B1386)", () => {
  it("P1 an unchanged stored 120,000-piece line resent while another line rises is allowed", () => {
    const lines = [
      stored("L1", { qty: 120_000 }),
      stored("L2", { id: "L2", productId: "p2", qty: 10 }),
    ];
    const items = [
      { productId: "p1", qty: 120_000, orderItemId: "L1" },
      { productId: "p2", qty: 50, orderItemId: "L2" },
    ];
    const products = new Map<string, any>([
      ["p1", { id: "p1", unitsPerBox: 0, trackedCategoryId: null }],
      ["p2", { id: "p2", unitsPerBox: 0, trackedCategoryId: null }],
    ]);
    expect(() => buyerEdit(items, lines, 0, { product: products })).not.toThrow();
  });

  it("P1b the same 120,000 line lowered to 110,000 is allowed (rise-only)", () => {
    expect(() =>
      buyerEdit(
        [{ productId: "p1", qty: 110_000, orderItemId: "L1" }],
        [stored("L1", { qty: 120_000 })],
        0,
      ),
    ).not.toThrow();
  });

  it("P3 the cart fold (no buyerLineIds) is not capped here", () => {
    expect(() =>
      pairEditLines(
        { items: [{ productId: "p1", qty: 120_000 }] },
        { lineItems: [stored("L1", { qty: 10 })] },
        productMap(0),
        noCats,
        { role: "CUSTOMER" },
        {},
      ),
    ).not.toThrow();
  });

  it("P4 8,333 packs of 12 (99,996 pieces) is allowed", () => {
    expect(() =>
      buyerEdit(
        [{ productId: "p1", qty: 8_333, orderItemId: "L1" }],
        [stored("L1", { qty: 10 })],
        12,
      ),
    ).not.toThrow();
  });

  it("P2 staff may raise a line to 240,000", () => {
    expect(() =>
      pairEditLines(
        { items: [{ productId: "p1", qty: 240_000, orderItemId: "L1" }] },
        { lineItems: [stored("L1", { qty: 120_000 })] },
        productMap(0),
        noCats,
        { role: "OPERATOR" },
        {},
      ),
    ).not.toThrow();
  });
});
