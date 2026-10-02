import { stockWriteOf, withStockWrite, type StockWriteResult } from "./order-stock";
import { buyerCreateResponse, carryCreatedWrite, withBackorderPieces } from "./backorder-response";

/**
 * SA-606o: the buyer response carries `backorderPieces` per line = the pieces THIS write
 * backordered, attributed over the RESPONSE order's lines (per product, response order, stock-first).
 * Overriding rule: the write has COMMITTED when this runs, so the function is TOTAL — anything it
 * cannot resolve OMITS the key on the whole order (absent = unknown). It never throws, never sends
 * NaN, never guesses 0.
 */
const sw = (entries: Array<[string, number]>): StockWriteResult => ({
  backorderByProduct: new Map(entries),
});
const li = (
  id: string,
  productId: string | null,
  qty: number,
  extra: Record<string, unknown> = {},
  pack: unknown = null,
) => ({
  id,
  productId,
  qty,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  status: "PENDING",
  product: productId ? { id: productId, unitsPerBox: pack } : null,
  ...extra,
});
const order = (lineItems: any[]) => ({ id: "o-1", orderNumber: "A1", lineItems });
const figures = (o: any) => o.lineItems.map((l: any) => l.backorderPieces);
const noKey = (o: any) => o.lineItems.every((l: any) => !("backorderPieces" in l));

describe("withBackorderPieces — attribution (Q-A)", () => {
  it("stock-first over the response lines: [6,6,3] with overshoot 5 -> [0,2,3], sum == overshoot", () => {
    const o = order([li("a", "p", 6), li("b", "p", 6), li("c", "p", 3)]);
    const out = withBackorderPieces(o, sw([["p", 5]]));
    expect(figures(out)).toEqual([0, 2, 3]);
  });

  it("does not mutate its input and keeps every other field", () => {
    const o = order([li("a", "p", 4)]);
    const out: any = withBackorderPieces(o, sw([["p", 1]]));
    expect("backorderPieces" in o.lineItems[0]).toBe(false);
    expect(out.orderNumber).toBe("A1");
    expect(out.lineItems[0].id).toBe("a");
  });

  it("a product this write did not touch, an unlisted line and a CANCELLED line are 0 (computed)", () => {
    const o = order([
      li("a", "p", 5),
      li("b", "q", 9),
      li("c", null, 4),
      li("d", "p", 7, { status: "CANCELLED" }),
    ]);
    // p overshoot 2 over a live demand of 5 (the cancelled line is not demand)
    expect(figures(withBackorderPieces(o, sw([["p", 2]])))).toEqual([2, 0, 0, 0]);
  });

  it("a policy-off write (overshoot 0) puts 0 on every line, present", () => {
    const o = order([li("a", "p", 3), li("b", "q", 2)]);
    expect(
      figures(
        withBackorderPieces(
          o,
          sw([
            ["p", 0],
            ["q", 0],
          ]),
        ),
      ),
    ).toEqual([0, 0]);
  });

  it("a removed line's product with overshoot 0 does not make the response lose the key", () => {
    // an edit that lowered `gone` to nothing leaves it in the map at 0; only overshoot > 0 matters
    const o = order([li("a", "p", 5)]);
    expect(
      figures(
        withBackorderPieces(
          o,
          sw([
            ["gone", 0],
            ["p", 3],
          ]),
        ),
      ),
    ).toEqual([3]);
  });

  it("a concurrent INCREASE passes: demand above the overshoot still attributes exactly the overshoot", () => {
    const o = order([li("a", "p", 10)]);
    expect(figures(withBackorderPieces(o, sw([["p", 3]])))).toEqual([3]);
  });
});

describe("withBackorderPieces — the line's pieces are the DECREMENT's own conversion (Q-B)", () => {
  it("(i) a snapshot pack that differs from the product's CURRENT pack: demand follows the snapshot", () => {
    // box-split line: 2 boxes of a 12-pack = 24 pieces. The product's pack is 6 NOW.
    // Overshoot 20 needs demand 24; with the live pack (12 pieces) it would be a lost write -> omit.
    const o = order([li("a", "p", 24, { boxes: 2, pieces: 0, unitsPerBox: 12 }, 6)]);
    expect(figures(withBackorderPieces(o, sw([["p", 20]])))).toEqual([20]);
  });

  it("a box-unaware line is sized by the product's live pack (2 boxes of a 12-pack = 24)", () => {
    const o = order([li("a", "p", 2, {}, 12)]);
    expect(figures(withBackorderPieces(o, sw([["p", 4]])))).toEqual([4]);
  });

  it("(ii) a folded-in OLD line with a non-finite pack: the product cannot be resolved -> key OMITTED", () => {
    const o = order([li("a", "p", 2, {}, Number.NaN), li("b", "p", 3, {}, Number.NaN)]);
    const out = withBackorderPieces(o, sw([["p", 1]]));
    expect(noKey(out)).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/NaN|null.*backorder/);
  });
});

describe("withBackorderPieces — a response that cannot supply the pack is unresolvable", () => {
  it("lines whose product was selected WITHOUT unitsPerBox (a narrower read) -> key omitted, never a pieces-as-boxes guess", () => {
    // a box-unaware boxed line: qty 2 is BOXES. Without the pack the figure would size it as 2 pieces.
    const bare = { ...li("a", "p", 2), product: { id: "p", name: "Widget", unit: "case" } };
    expect(noKey(withBackorderPieces(order([bare]), sw([["p", 1]])))).toBe(true);
  });

  it("a line with no product row at all is unresolvable too", () => {
    const orphan = { ...li("a", "p", 2), product: null };
    expect(noKey(withBackorderPieces(order([orphan]), sw([["p", 1]])))).toBe(true);
  });
});

describe("withBackorderPieces — lost write or too little demand: omit on the WHOLE order (Q-D)", () => {
  it("a product with overshoot > 0 and no line in the response", () => {
    expect(noKey(withBackorderPieces(order([li("a", "q", 5)]), sw([["p", 3]])))).toBe(true);
  });

  it("demand below the overshoot (a concurrent edit lowered the lines)", () => {
    expect(noKey(withBackorderPieces(order([li("a", "p", 2)]), sw([["p", 5]])))).toBe(true);
  });

  it("never partial: one resolvable product does not keep its figure when another is lost", () => {
    const o = order([li("a", "p", 5)]);
    expect(
      noKey(
        withBackorderPieces(
          o,
          sw([
            ["p", 2],
            ["lost", 4],
          ]),
        ),
      ),
    ).toBe(true);
  });
});

describe("withBackorderPieces — total: nothing after the commit may throw or invent a number", () => {
  it("no stock write (replay, draft, staff) -> the order unchanged, key absent", () => {
    const o = order([li("a", "p", 5)]);
    expect(withBackorderPieces(o, undefined)).toBe(o);
  });

  it("a malformed response (no lineItems, null) comes back as given", () => {
    const noLines: any = { id: "o" };
    expect(withBackorderPieces(noLines, sw([["p", 1]]))).toBe(noLines);
    expect(withBackorderPieces(null as any, sw([["p", 1]]))).toBeNull();
  });

  it("a failure injected while building the figures still returns the order, key absent", () => {
    const o: any = order([li("a", "p", 5)]);
    Object.defineProperty(o, "lineItems", {
      get() {
        throw new Error("read failed after commit");
      },
    });
    let out: any;
    expect(() => (out = withBackorderPieces(o, sw([["p", 2]])))).not.toThrow();
    expect(out).toBe(o);
  });

  it("never emits NaN, Infinity or a negative number", () => {
    const o = order([li("a", "p", 4), li("b", "p", Number.POSITIVE_INFINITY)]);
    const out: any = withBackorderPieces(o, sw([["p", 2]]));
    for (const v of figures(out))
      if (v !== undefined) expect(Number.isFinite(v) && v >= 0).toBe(true);
  });
});

describe("the stock-write carrier", () => {
  it("is typed, non-enumerable and never on the wire", () => {
    const o: any = { id: "o", lineItems: [] };
    const carried = withStockWrite(o, sw([["p", 3]]));
    expect(carried).toBe(o);
    expect(stockWriteOf(carried)?.backorderByProduct.get("p")).toBe(3);
    expect(JSON.stringify(carried)).toBe('{"id":"o","lineItems":[]}');
    expect(Object.keys(carried)).toEqual(["id", "lineItems"]);
    expect(stockWriteOf({ ...carried })).toBeUndefined(); // a spread copy drops it
  });

  it("is undefined on anything that never carried one", () => {
    expect(stockWriteOf({ id: "o" })).toBeUndefined();
    expect(stockWriteOf(null)).toBeUndefined();
    expect(withStockWrite({ id: "o" }, undefined)).toEqual({ id: "o" });
    expect(stockWriteOf(withStockWrite({ id: "o" }, undefined))).toBeUndefined();
  });
});

describe("buyerCreateResponse — which order carries the figure after the post-commit sweep", () => {
  const created = (extra: Record<string, unknown> = {}) =>
    withStockWrite(
      { ...order([li("c1", "p", 8)]), id: "o-new", skipAutoMerge: false, ...extra },
      sw([["p", 3]]),
    );

  it("a PLAIN checkout: the sweep returns the BARE created row (same id, lines without a product) -> the figure lands on `created`", () => {
    const bare = {
      id: "o-new",
      customerId: "cust-1",
      lineItems: [{ id: "c1", productId: "p", qty: 8, status: "PENDING" }], // the real findMany shape: no `product`
    };
    const res: any = buyerCreateResponse(created(), bare);
    expect(res.id).toBe("o-new");
    expect(figures(res)).toEqual([3]);
  });

  it("no sweep result (null / nothing to fold) -> `created`", () => {
    expect(figures(buyerCreateResponse(created(), null))).toEqual([3]);
    expect(figures(buyerCreateResponse(created(), undefined))).toEqual([3]);
  });

  it("a fold into ANOTHER order (created was merge-eligible) -> the figure lands on the merged order's lines", () => {
    const merged = { ...order([li("m1", "p", 5), li("m2", "p", 8)]), id: "o-old" };
    const res: any = buyerCreateResponse(created(), merged);
    expect(res.id).toBe("o-old");
    expect(figures(res)).toEqual([0, 3]);
  });

  it("created was NOT merge-eligible and the sweep returned another order: that order is returned untouched, NO number invented on it", () => {
    const other = { ...order([li("m1", "p", 8)]), id: "o-other" };
    const res: any = buyerCreateResponse(created({ skipAutoMerge: true }), other);
    expect(res).toBe(other);
    expect(noKey(res)).toBe(true);
  });

  it("an unknown eligibility (no skipAutoMerge on created) is never treated as eligible", () => {
    const other = { ...order([li("m1", "p", 8)]), id: "o-other" };
    const c: any = created();
    delete c.skipAutoMerge;
    expect(noKey(buyerCreateResponse(c, other) as any)).toBe(true);
  });

  it("is total: a throwing created order still returns something, never throws", () => {
    const bad: any = {};
    Object.defineProperty(bad, "id", {
      get() {
        throw new Error("boom");
      },
    });
    const merged = { id: "o-x", lineItems: [] };
    expect(() => buyerCreateResponse(bad, merged)).not.toThrow();
  });
});

describe("carryCreatedWrite — the carrier rides ONLY on an order it describes (B975)", () => {
  const created = (extra: Record<string, unknown> = {}) =>
    withStockWrite({ id: "o-new", skipAutoMerge: false, lineItems: [], ...extra }, sw([["p", 3]]));
  const wroteOn = (o: any) => stockWriteOf(o)?.backorderByProduct.get("p");

  it("nothing from the sweep, or the SAME order (a bare row): the CREATED order, carrying its write", () => {
    const c = created();
    expect(carryCreatedWrite(c, null)).toBe(c);
    const out: any = carryCreatedWrite(c, { id: "o-new", lineItems: [] });
    expect(out).toBe(c);
    expect(wroteOn(out)).toBe(3);
  });

  it("folded into ANOTHER order (created merge-eligible): the merged order carries the write", () => {
    const merged = { id: "o-old", lineItems: [] };
    const out: any = carryCreatedWrite(created(), merged);
    expect(out).toBe(merged);
    expect(wroteOn(out)).toBe(3);
  });

  it("another order and created NOT eligible (or unknown): that order comes back with NO carrier", () => {
    const other = { id: "o-other", lineItems: [] };
    expect(wroteOn(carryCreatedWrite(created({ skipAutoMerge: true }), other))).toBeUndefined();
    const unknown: any = created();
    delete unknown.skipAutoMerge;
    expect(wroteOn(carryCreatedWrite(unknown, { id: "o-x", lineItems: [] }))).toBeUndefined();
  });
});
