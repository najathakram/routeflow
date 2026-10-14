import { computeLineSubtotal } from "@routeflow/pricing";
import {
  canSellByCase,
  cartOrderItems,
  completeLineFromCatalog,
  hydrateCartLine,
  isLineConsistent,
  lineCount,
  lineQtyText,
  lineUnit,
  mergeCartLines,
  hasContradiction,
  newCartLine,
  normalizeCartLine,
  setLineCount,
  setLineUnit,
  type CartLineShape,
} from "./buyer-cart-line";

/** Row 531: the ONE normaliser behind every cart mutation. qty is PIECES; the split is derived. */

const UPB = 12;
const line = (over: Partial<CartLineShape> = {}): CartLineShape => ({
  qty: 12,
  unitsPerBox: UPB,
  boxes: 1,
  pieces: 0,
  ...over,
});

describe("normalizeCartLine", () => {
  it.each([
    [0, 0, 0],
    [1, 0, 1],
    [11, 0, 11],
    [12, 1, 0],
    [13, 1, 1],
    [24, 2, 0],
    [25, 2, 1],
  ])("qty %i derives boxes %i / pieces %i and agrees with itself", (qty, boxes, pieces) => {
    const n = normalizeCartLine(line({ qty, boxes: 99, pieces: 99 }));
    expect(n).toMatchObject({ qty, boxes, pieces });
    expect(n.boxes! * UPB + n.pieces!).toBe(n.qty);
    expect(n.pieces!).toBeLessThan(UPB);
  });

  it("qty wins over a stale split (the P0 shape: qty 2 / boxes 1 / pieces 0)", () => {
    expect(normalizeCartLine(line({ qty: 2, boxes: 1, pieces: 0 }))).toMatchObject({
      qty: 2,
      boxes: 0,
      pieces: 2,
    });
  });

  it("drops the split keys on a plain product and truncates its qty to an integer", () => {
    const n = normalizeCartLine({ qty: 3.9, boxes: 1, pieces: 0, unitsPerBox: null });
    expect(n.qty).toBe(3);
    expect(n.boxes).toBeUndefined();
    expect(n.pieces).toBeUndefined();
    expect(normalizeCartLine<CartLineShape>({ qty: 4, unitsPerBox: 1 }).boxes).toBeUndefined();
  });

  it("is idempotent", () => {
    const once = normalizeCartLine(line({ qty: 25, boxes: 7 }));
    expect(normalizeCartLine(once)).toEqual(once);
  });
});

describe("setLineCount: the typed number is in the line's selling unit", () => {
  it.each([1, 2, 5, 11, 12, 13, 24, 25])("a Case line typed %i is %i Cases", (n) => {
    const l = setLineCount(line({ sellBy: "CASE" }), n);
    expect(l).toMatchObject({ qty: n * UPB, boxes: n, pieces: 0, sellBy: "CASE" });
    expect(isLineConsistent(l)).toBe(true);
  });

  it.each([1, 2, 11, 12, 13, 24, 25])("an Each line typed %i is %i pieces", (n) => {
    const l = setLineCount(line({ sellBy: "EACH" }), n);
    expect(l).toMatchObject({ qty: n, boxes: Math.floor(n / UPB), pieces: n % UPB });
    expect(isLineConsistent(l)).toBe(true);
  });

  it("2 on a 12/box Case line prices as 2 Cases; 2 on an Each line as 2 of 12 of a Case", () => {
    const price = (l: CartLineShape) =>
      computeLineSubtotal({
        unitPrice: 15.6,
        qty: l.qty,
        boxes: l.boxes,
        pieces: l.pieces,
        unitsPerBox: l.unitsPerBox,
      });
    expect(price(setLineCount(line({ sellBy: "CASE" }), 2))).toBe(31.2);
    expect(price(setLineCount(line({ sellBy: "EACH" }), 2))).toBe(2.6);
  });
});

describe("setLineUnit: the toggle never moves the money", () => {
  it("Case to Each keeps qty; Each back to Case only while no loose pieces exist", () => {
    const each = setLineUnit(line({ qty: 24, boxes: 2, sellBy: "CASE" }), "EACH");
    expect(each).toMatchObject({ qty: 24, boxes: 2, pieces: 0, sellBy: "EACH" });
    expect(lineCount(each)).toBe(24);
    expect(canSellByCase(each)).toBe(true);
    expect(setLineUnit(each, "CASE")).toMatchObject({ qty: 24, sellBy: "CASE" });
    expect(lineCount(setLineUnit(each, "CASE"))).toBe(2);

    const loose = setLineCount(each, 25);
    expect(canSellByCase(loose)).toBe(false);
    expect(setLineUnit(loose, "CASE")).toMatchObject({
      qty: 25,
      boxes: 2,
      pieces: 1,
      sellBy: "EACH",
    });
  });

  it("a plain product has no unit to switch", () => {
    const plain = { qty: 3, unitsPerBox: null } as CartLineShape;
    expect(setLineUnit(plain, "CASE")).toBe(plain);
    expect(lineUnit(plain)).toBe("EACH");
  });
});

describe("hydrateCartLine: a stored mismatched line is rebuilt from qty", () => {
  it.each([
    // [stored qty, stored boxes, stored pieces] -> [qty, boxes, pieces, unit]
    [2, 1, 0, 2, 0, 2, "EACH"],
    [30, 1, 0, 30, 2, 6, "EACH"],
    [24, 1, 0, 24, 2, 0, "CASE"],
    [12, 1, 0, 12, 1, 0, "CASE"],
    [5, 0, 5, 5, 0, 5, "EACH"],
  ])("qty %i / boxes %i / pieces %i -> %i / %i / %i (%s)", (q, b, p, eq, eb, ep, unit) => {
    expect(hydrateCartLine(line({ qty: q, boxes: b, pieces: p }))).toMatchObject({
      qty: eq,
      boxes: eb,
      pieces: ep,
      sellBy: unit,
    });
  });

  it("leaves an unusable qty alone rather than inventing one", () => {
    const bad = line({ qty: 0 });
    expect(hydrateCartLine(bad)).toBe(bad);
  });
});

describe("completeLineFromCatalog: a bare older Add is whole Cases", () => {
  it("qty 3 with no pack, catalog pack 12 -> 3 Cases (36 pieces), the amount the server would bill", () => {
    expect(completeLineFromCatalog({ qty: 3 } as CartLineShape, 12)).toMatchObject({
      qty: 36,
      boxes: 3,
      pieces: 0,
      unitsPerBox: 12,
      sellBy: "CASE",
    });
  });

  it("does nothing for a line already in the catalog's pack, or a plain product", () => {
    const l = line();
    expect(completeLineFromCatalog(l, 12)).toBe(l);
    const plain = { qty: 2 } as CartLineShape;
    expect(completeLineFromCatalog(plain, null)).toBe(plain);
    expect(completeLineFromCatalog(plain, 1)).toBe(plain);
  });
});

describe("newCartLine: Add writes one Case, or one piece of a plain product", () => {
  const p = { productId: "p1", name: "Widget", unit: "each", thumbnailUrl: null };
  it("a boxed product -> 1 box, 0 pieces, qty = pack, sold by Case", () => {
    expect(newCartLine(p, 12)).toMatchObject({
      qty: 12,
      boxes: 1,
      pieces: 0,
      unitsPerBox: 12,
      sellBy: "CASE",
    });
    expect(newCartLine(p, 12, 3)).toMatchObject({ qty: 36, boxes: 3, pieces: 0 });
  });
  it("a plain product -> qty 1 and no split keys", () => {
    const l = newCartLine(p, null);
    expect(l.qty).toBe(1);
    expect(l.boxes).toBeUndefined();
    expect(l.pieces).toBeUndefined();
  });
});

describe("lineQtyText names the unit and the quantity", () => {
  it.each([
    [{ qty: 12, sellBy: "CASE" as const }, "1 Case (12 ea)"],
    [{ qty: 24, sellBy: "CASE" as const }, "2 Cases (24 ea)"],
    [{ qty: 2, sellBy: "EACH" as const }, "2 Each"],
    [{ qty: 24, sellBy: "EACH" as const }, "24 Each (2 Cases)"],
    [{ qty: 15, sellBy: "EACH" as const }, "15 Each (1 Case + 3 ea)"],
  ])("%j -> %s", (l, text) => {
    expect(lineQtyText({ ...l, unitsPerBox: UPB })).toBe(text);
  });
  it("is empty for a plain product", () => {
    expect(lineQtyText({ qty: 3, unitsPerBox: null })).toBe("");
  });
});

describe("cartOrderItems: the checkout payload always agrees with itself", () => {
  it("boxed lines carry qty + boxes + pieces; plain lines carry qty alone", () => {
    const items = cartOrderItems([
      { productId: "a", ...line({ qty: 2, boxes: 1, pieces: 0 }) }, // a stale line that slipped in
      { productId: "b", qty: 4, unitsPerBox: null },
      { productId: "c", ...line({ qty: 24, boxes: 2, pieces: 0 }) },
    ]);
    expect(items).toEqual([
      { productId: "a", qty: 2, boxes: 0, pieces: 2 },
      { productId: "b", qty: 4 },
      { productId: "c", qty: 24, boxes: 2, pieces: 0 },
    ]);
  });
});

describe("completeLineFromCatalog: a repack (R1)", () => {
  it("a Case line keeps its Case count under the catalog's new pack", () => {
    expect(completeLineFromCatalog(line({ qty: 36, boxes: 3, sellBy: "CASE" }), 6)).toMatchObject({
      unitsPerBox: 6,
      qty: 18,
      boxes: 3,
      pieces: 0,
      sellBy: "CASE",
    });
  });

  it("an Each line keeps its pieces under the catalog's new pack", () => {
    expect(
      completeLineFromCatalog(line({ qty: 14, boxes: 1, pieces: 2, sellBy: "EACH" }), 6),
    ).toMatchObject({ unitsPerBox: 6, qty: 14, boxes: 2, pieces: 2, sellBy: "EACH" });
  });

  it("an Each line holding whole Cases stays an Each line (the buyer chose pieces)", () => {
    const r = completeLineFromCatalog(line({ qty: 24, boxes: 2, sellBy: "EACH" }), 8);
    expect(r).toMatchObject({ unitsPerBox: 8, qty: 24, boxes: 3, pieces: 0, sellBy: "EACH" });
  });

  it("a repacked line is flagged as corrected; an unchanged pack is returned as-is", () => {
    expect(completeLineFromCatalog(line(), 6).corrected).toBe(true);
    const same = line();
    expect(completeLineFromCatalog(same, 12)).toBe(same);
  });

  it("every repack leaves qty === boxes*pack + pieces", () => {
    for (const unit of ["CASE", "EACH"] as const)
      for (const pack of [2, 5, 6, 8, 10, 24]) {
        const r = completeLineFromCatalog(
          line({ qty: 25, boxes: 2, pieces: 1, sellBy: unit }),
          pack,
        );
        expect(r.boxes! * pack + r.pieces!).toBe(r.qty);
        expect(isLineConsistent(r)).toBe(true);
      }
  });
});

describe("hasContradiction: only a split that disagrees with its own qty counts", () => {
  it.each([
    [line({ qty: 2, boxes: 1, pieces: 0 }), true],
    [line({ qty: 30, boxes: 1, pieces: 0 }), true],
    [line({ qty: 24, boxes: 2, pieces: 0 }), false],
    [line({ qty: 12, boxes: undefined, pieces: undefined }), false], // no split stored: nothing to contradict
    [{ qty: 3, unitsPerBox: null, boxes: 1 } as CartLineShape, false], // not boxed
  ])("%j -> %s", (l, expected) => {
    expect(hasContradiction(l)).toBe(expected);
  });
});

describe("mergeCartLines (S2)", () => {
  it("both boxed, same pack: adds in pieces and re-derives the split", () => {
    expect(mergeCartLines(line({ qty: 12 }), line({ qty: 24, boxes: 2 }))).toMatchObject({
      qty: 36,
      boxes: 3,
      pieces: 0,
    });
  });

  it("a bare incoming qty on a boxed line is CASES (the server bills a bare buyer qty in selling units)", () => {
    const bare = { qty: 2 } as CartLineShape;
    expect(mergeCartLines(line(), bare)).toMatchObject({ qty: 36, boxes: 3, pieces: 0 });
  });

  it("a bare stored line takes the boxed incoming side's pack, in Cases", () => {
    const bare = { qty: 2 } as CartLineShape;
    expect(mergeCartLines(bare, line({ unitsPerBox: 6, qty: 6, boxes: 1 }))).toMatchObject({
      unitsPerBox: 6,
      qty: 18,
      boxes: 3,
    });
  });

  it("two boxed sides with different packs: the incoming pack wins and the stored Case count is kept", () => {
    expect(
      mergeCartLines(
        line({ qty: 24, boxes: 2, sellBy: "CASE" }),
        line({ unitsPerBox: 6, qty: 6, boxes: 1 }),
      ),
    ).toMatchObject({ unitsPerBox: 6, qty: 18, boxes: 3, pieces: 0 });
  });

  it("an Each stored line stays Each after a merge", () => {
    const each = line({ qty: 5, boxes: 0, pieces: 5, sellBy: "EACH" });
    expect(mergeCartLines(each, line())).toMatchObject({
      qty: 17,
      boxes: 1,
      pieces: 5,
      sellBy: "EACH",
    });
  });

  it("two plain lines just add", () => {
    expect(mergeCartLines({ qty: 2 } as CartLineShape, { qty: 3 } as CartLineShape)).toMatchObject({
      qty: 5,
    });
  });
});
