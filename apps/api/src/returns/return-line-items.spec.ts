/**
 * SA-1042 B9b rules 3-5: a return item may name its order line. `resolveLineItems` finds the line, picks the count shape and
 * converts to pieces; `assertLineCaps` caps each line on its own pieces. Pooled items (no orderItemId) are not touched here.
 */
import { BadRequestException, ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  assertLineCaps,
  isLineItem,
  lineLeftText,
  resolveLineItems,
  type LineItemInput,
} from "./return-line-items";

const P = "p1";
// Product P: pack 10 at 2.50 a box, and a Case of 200. Line A: 2 Cases (400 pcs); line B: 10 boxes (100 pcs).
const lineA = {
  id: "A",
  productId: P,
  qty: 400,
  status: "ACTIVE",
  boxes: 2,
  pieces: 0,
  unitsPerBox: 200,
  unitLabel: "Case",
};
const lineB = {
  id: "B",
  productId: P,
  qty: 100,
  status: "ACTIVE",
  boxes: 10,
  pieces: 0,
  unitsPerBox: 10,
};
const order = (...lines: any[]) => ({ lineItems: lines });
const oneFactor = new Map<string, any>([[P, { factor: 1 }]]);
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return { type: e.constructor, code: e.getResponse?.()?.code, message: e.message };
  }
  return null;
};

describe("isLineItem", () => {
  it("is true only when the item names a line", () => {
    const item = (i: LineItemInput) => isLineItem(i);
    expect(item({ productId: P, orderItemId: "A", boxes: 1 })).toBe(true);
    expect(item({ productId: P, qty: 1 })).toBe(false);
    expect(item({ productId: P, qty: 1, orderItemId: "" })).toBe(false);
  });
});

describe("resolveLineItems (rule 4)", () => {
  const resolve = (items: any[], o = order(lineA, lineB), bases = oneFactor) =>
    resolveLineItems(o as any, items, bases);

  it("N-r4: one Case on the Case line is 200 pieces, stored qty 200", () => {
    const [r] = resolve([{ productId: P, orderItemId: "A", boxes: 1, pieces: 0 }]);
    expect(r).toMatchObject({ index: 0, orderItemId: "A", pieces: 200, qty: 200, lineUnit: false });
  });

  it("boxes plus loose pieces on a pack line: 3 boxes + 2 = 32 pieces", () => {
    const [r] = resolve([{ productId: P, orderItemId: "B", boxes: 3, pieces: 2 }]);
    expect(r).toMatchObject({ pieces: 32, qty: 32 });
  });

  it("a factor-1 unit line (no split, label + snapshot 1) takes boxes as its own unit count", () => {
    const piece = {
      id: "U",
      productId: P,
      qty: 5,
      status: "ACTIVE",
      unitLabel: "Piece",
      unitsPerBox: 1,
    };
    const [r] = resolve([{ productId: P, orderItemId: "U", boxes: 3 }], order(piece));
    expect(r).toMatchObject({ pieces: 3, qty: 3 });
  });

  it("a legacy box-unaware line takes qty in its own unit (boxes), converted with the product factor", () => {
    const legacy = { id: "L", productId: P, qty: 4, status: "ACTIVE", unitsPerBox: 12 };
    const [r] = resolve(
      [{ productId: P, orderItemId: "L", qty: 2 }],
      order(legacy),
      new Map([[P, { factor: 12 }]]),
    );
    expect(r).toMatchObject({ pieces: 24, qty: 2 });
  });

  it("G-r5: a line of another order, a CANCELLED line, or another product's line is RETURN_LINE_NOT_ON_ORDER (400)", () => {
    const cancelled = { ...lineB, id: "C", status: "CANCELLED" };
    const other = { ...lineB, id: "O", productId: "p2" };
    for (const [id, o] of [
      ["zzz", order(lineA)],
      ["C", order(lineA, cancelled)],
      ["O", order(lineA, other)],
    ] as const) {
      const got = codeOf(() => resolve([{ productId: P, orderItemId: id, boxes: 1 }], o as any));
      expect(got).toMatchObject({
        type: BadRequestException,
        code: API_ERROR_CODES.RETURN_LINE_NOT_ON_ORDER,
      });
    }
  });

  it("G-r6: qty with boxes, a split on a box-unaware line, and no count at all are RETURN_LINE_COUNT_SHAPE (400)", () => {
    const legacy = { id: "L", productId: P, qty: 4, status: "ACTIVE", unitsPerBox: 12 };
    const shapes: any[] = [
      [{ productId: P, orderItemId: "A", qty: 5, boxes: 1 }, order(lineA)],
      [{ productId: P, orderItemId: "L", boxes: 1 }, order(legacy)],
      [{ productId: P, orderItemId: "A" }, order(lineA)],
      [{ productId: P, orderItemId: "A", boxes: 1.5 }, order(lineA)],
      [{ productId: P, orderItemId: "A", boxes: -1 }, order(lineA)],
    ];
    for (const [item, o] of shapes) {
      const got = codeOf(() => resolve([item], o, new Map([[P, { factor: 1 }]])));
      expect(got).toMatchObject({
        type: BadRequestException,
        code: API_ERROR_CODES.RETURN_LINE_COUNT_SHAPE,
      });
    }
  });

  it("G-r6: a line item and a pooled item of one product in a payload is RETURN_LINE_MIXED_WITH_POOLED (400)", () => {
    const got = codeOf(() =>
      resolve([
        { productId: P, orderItemId: "A", boxes: 1 },
        { productId: P, qty: 10 },
      ]),
    );
    expect(got).toMatchObject({
      type: BadRequestException,
      code: API_ERROR_CODES.RETURN_LINE_MIXED_WITH_POOLED,
    });
  });

  it("G-r8: a mixed-factor product stays today's 409, with line items too", () => {
    const got = codeOf(() =>
      resolve(
        [{ productId: P, orderItemId: "A", boxes: 1 }],
        order(lineA, lineB),
        new Map([[P, { mixed: true, factors: [1, 12] }]]),
      ),
    );
    expect(got?.type).toBe(ConflictException);
  });

  it("G-r9: a legacy single-unit product (SA-161) takes qty in the line's unit, no pack, and carries no line key (A-2: pooled)", () => {
    const legacy = { id: "L", productId: P, qty: 4, status: "ACTIVE" };
    const bases = new Map([[P, { unknown: true, reason: "no pack", singleUnit: true }]]) as any;
    const [r] = resolve([{ productId: P, orderItemId: "L", qty: 3 }], order(legacy), bases);
    expect(r).toMatchObject({ lineUnit: true, qty: 3, pieces: null, orderItemId: null });
    // the named line is still validated: a line that is not on the order is a 400, nothing resolved
    expect(
      codeOf(() => resolve([{ productId: P, orderItemId: "WRONG", qty: 3 }], order(legacy), bases)),
    ).toMatchObject({ code: API_ERROR_CODES.RETURN_LINE_NOT_ON_ORDER });
    const split = codeOf(() =>
      resolve([{ productId: P, orderItemId: "L", boxes: 1 }], order(legacy), bases),
    );
    expect(split).toMatchObject({ code: API_ERROR_CODES.RETURN_LINE_COUNT_SHAPE });
  });

  it("pooled items resolve to nothing", () => {
    expect(resolve([{ productId: P, qty: 10 }])).toEqual([]);
  });
});

describe("lineLeftText (rule 5)", () => {
  it("names what is left in the line's own unit", () => {
    expect(lineLeftText(lineB as any, 100, 1)).toBe("100 pcs (10 boxes)");
    expect(lineLeftText(lineA as any, 200, 1)).toBe("200 pcs (1 Case)");
  });

  it("A-8: a unit line reads its own word, one or many, and a part count stays true", () => {
    const unit = { id: "U", productId: P, qty: 10, unitLabel: "Case", unitsPerBox: 1 } as any;
    expect(lineLeftText(unit, 5, 1)).toBe("5 Cases");
    expect(lineLeftText(unit, 1, 1)).toBe("1 Case");
    expect(lineLeftText(unit, 1.5, 1)).toBe("1.5 Case");
  });

  it.each([
    ["snapshot 12", { unitsPerBox: 12 }],
    ["a null snapshot", { unitsPerBox: null }],
    ["a stale label", { unitsPerBox: 12, unitLabel: "Case" }],
  ])("A-8: a legacy line with %s reads its left count bare, in the line's unit", (_n, shape) => {
    const legacy = { id: "L", productId: P, qty: 10, ...shape } as any;
    expect(lineLeftText(legacy, 24, 12)).toBe("2");
    expect(lineLeftText(legacy, 12, 1)).toBe("12");
  });
});

describe("assertLineCaps (rule 5)", () => {
  const resolved = (items: any[]) => resolveLineItems(order(lineA, lineB) as any, items, oneFactor);

  it("R-r2: 110 pieces on the 100-piece line is a 400 naming what is left, nothing else", () => {
    const r = resolved([{ productId: P, orderItemId: "B", qty: 110 }]);
    const got = codeOf(() => assertLineCaps(r, order(lineA, lineB) as any, new Map(), oneFactor));
    expect(got?.type).toBe(BadRequestException);
    expect(got?.message).toMatch(/exceeds what is left on this line: 100 pcs \(10 boxes\)/);
  });

  it("A-8: the 400 reads in the line's own text on a unit line and a legacy line", () => {
    const unit = {
      id: "U",
      productId: P,
      qty: 10,
      status: "ACTIVE",
      unitLabel: "Case",
      unitsPerBox: 1,
    };
    const u = resolveLineItems(
      order(unit) as any,
      [{ productId: P, orderItemId: "U", boxes: 11 }],
      oneFactor,
    );
    expect(codeOf(() => assertLineCaps(u, order(unit) as any, new Map(), oneFactor))?.message).toBe(
      "Return qty exceeds what is left on this line: 10 Cases.",
    );

    const legacy = { id: "L", productId: P, qty: 10, status: "ACTIVE", unitsPerBox: 12 };
    const pack12 = new Map<string, any>([[P, { factor: 12 }]]);
    const l = resolveLineItems(
      order(legacy) as any,
      [{ productId: P, orderItemId: "L", qty: 3 }],
      pack12,
    );
    expect(
      codeOf(() => assertLineCaps(l, order(legacy) as any, new Map([["L", 96]]), pack12))?.message,
    ).toBe("Return qty exceeds what is left on this line: 2.");
  });

  it("G-r10: priors on the line are netted, and so are earlier items for the same line in this payload", () => {
    const one = resolved([{ productId: P, orderItemId: "A", boxes: 2 }]);
    // 1 Case already returned on A: 2 more Cases is over (1 Case left)
    const over = codeOf(() =>
      assertLineCaps(one, order(lineA, lineB) as any, new Map([["A", 200]]), oneFactor),
    );
    expect(over?.message).toMatch(/200 pcs \(1 Case\)/);
    // 1 Case prior + 1 Case now: exactly the line's 2
    const ok = resolved([{ productId: P, orderItemId: "A", boxes: 1 }]);
    expect(() =>
      assertLineCaps(ok, order(lineA, lineB) as any, new Map([["A", 200]]), oneFactor),
    ).not.toThrow();
    // two items for the same line in one payload accumulate
    const twice = resolved([
      { productId: P, orderItemId: "A", boxes: 1 },
      { productId: P, orderItemId: "A", boxes: 2 },
    ]);
    expect(() => assertLineCaps(twice, order(lineA, lineB) as any, new Map(), oneFactor)).toThrow(
      BadRequestException,
    );
  });

  it("a legacy single-unit (lineUnit) item is not capped per line: today's lineUnit cap stands", () => {
    const legacy = { id: "L", productId: P, qty: 4, status: "ACTIVE" };
    const bases = new Map([[P, { unknown: true, reason: "no pack", singleUnit: true }]]) as any;
    const r = resolveLineItems(
      order(legacy) as any,
      [{ productId: P, orderItemId: "L", qty: 99 }],
      bases,
    );
    expect(() => assertLineCaps(r, order(legacy) as any, new Map(), bases)).not.toThrow();
  });
});
