import { planSplitPromos } from "./split-promo-group";

/**
 * B297 row 355: the buyer replace-all prices a product on several lines on its COMBINED quantity; each
 * entry is read from its OWN line (pack vs pieces), free units go oldest line first, one-line products
 * get no group.
 */
const products = new Map([
  ["p1", { unitsPerBox: null }],
  ["boxed", { unitsPerBox: 12 }],
]);
const none = new Set<string>();

describe("planSplitPromos", () => {
  it("gives no group to a product on one line", () => {
    expect(planSplitPromos([{ productId: "p1", qty: 12 }], [], products, none).size).toBe(0);
  });

  it("measures two lines of an unboxed product together", () => {
    const g = planSplitPromos(
      [
        { productId: "p1", qty: 6 },
        { productId: "p1", qty: 6 },
      ],
      [],
      products,
      none,
    ).get("p1")!;
    expect(g).toMatchObject({ qtyPieces: 12, qtyUnits: 12 });
  });

  it("reads a pack line as selling units and a box-split line (named by its stored line) as pieces", () => {
    const lineItems = [
      { id: "L-pack", productId: "boxed", boxes: null, pieces: null },
      { id: "L-box", productId: "boxed", boxes: 2, pieces: 0 },
    ];
    const g = planSplitPromos(
      [
        { productId: "boxed", qty: 2, sourceLineId: "L-pack" },
        { productId: "boxed", qty: 24, sourceLineId: "L-box" },
      ],
      lineItems,
      products,
      none,
    ).get("boxed")!;
    // 2 packs = 24 pieces, + 24 pieces = 48 pieces = 4 boxes
    expect(g).toMatchObject({ qtyPieces: 48, qtyUnits: 4 });
    expect(g.denomination).toMatchObject({ boxes: 4, pieces: 0, unitsPerBox: 12 });
  });

  it("allocates the free units in PAYLOAD order: the stored half before the added half", () => {
    const items = [
      { productId: "p1", qty: 2, sourceLineId: "a" },
      { productId: "p1", qty: 7, sourceLineId: "b" },
      { productId: "p1", qty: 5 }, // added in this edit
    ];
    const g = planSplitPromos(items, [], products, none).get("p1")!;
    // 2 free over caps [a:2, b:7, new:5]: the first line (payload order) takes both
    expect(g.share(items[0], 2)).toBe(2);
    expect(g.share(items[1], 2)).toBe(0);
    expect(g.share(items[2], 2)).toBe(0);
  });
});
