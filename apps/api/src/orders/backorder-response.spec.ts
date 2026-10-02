import { NotFoundException } from "@nestjs/common";
import { stockWriteOf, withStockWrite, type StockWriteResult } from "./order-stock";
import { buyerCreateResponse, withBackorderPieces } from "./backorder-response";

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

describe("buyerCreateResponse — the holder is decided by EXISTENCE and read fresh (SA-631d)", () => {
  const created = (extra: Record<string, unknown> = {}) =>
    withStockWrite({ id: "o-new", skipAutoMerge: false, lineItems: [], ...extra }, sw([["p", 3]]));
  /** A reader over a fixed set of rows: an id with no row reads as GONE (null), like findOne's 404. */
  const reader = (rows: Record<string, unknown>) => jest.fn(async (id: string) => rows[id] ?? null);

  it("(i) other orders were folded INTO created (same id, more lines): the fresh read has the merged lines and total, with the figure", async () => {
    const read = reader({
      "o-new": { ...order([li("x", "p", 4), li("c1", "p", 8)]), id: "o-new", total: 120 },
    });
    const res: any = await buyerCreateResponse(created(), { id: "o-new", lineItems: [] }, read);
    expect(res.id).toBe("o-new");
    expect(res.total).toBe(120);
    expect(res.lineItems.map((l: any) => l.id)).toEqual(["x", "c1"]);
    expect(figures(res)).toEqual([0, 3]); // sum == the overshoot
    expect(read).toHaveBeenCalledWith("o-new");
  });

  it("(ii) created was folded INTO another order (its row is gone): the survivor is re-read and returned with the figure", async () => {
    const read = reader({
      "o-old": { ...order([li("m1", "p", 5), li("m2", "p", 8)]), id: "o-old" },
    });
    const res: any = await buyerCreateResponse(created(), { id: "o-old" }, read);
    expect(res.id).toBe("o-old");
    expect(figures(res)).toEqual([0, 3]);
    expect(read.mock.calls.map((c) => c[0])).toEqual(["o-new", "o-old"]);
  });

  it("(iii) created is not merge-eligible while another pair is swept: created still EXISTS, so it is returned (re-read) with the figure", async () => {
    const read = reader({ "o-new": { ...order([li("c1", "p", 8)]), id: "o-new" } });
    const res: any = await buyerCreateResponse(
      created({ skipAutoMerge: true }),
      { id: "o-other" },
      read,
    );
    expect(res.id).toBe("o-new");
    expect(figures(res)).toEqual([3]);
    expect(read).not.toHaveBeenCalledWith("o-other");
  });

  it("a PLAIN checkout (the sweep returned the bare created row): created is re-read FULL and carries the figure", async () => {
    const read = reader({ "o-new": { ...order([li("c1", "p", 8)]), id: "o-new" } });
    const bare = {
      id: "o-new",
      lineItems: [{ id: "c1", productId: "p", qty: 8, status: "PENDING" }],
    };
    expect(figures(await buyerCreateResponse(created(), bare, read))).toEqual([3]);
    expect(figures(await buyerCreateResponse(created(), null, read))).toEqual([3]);
  });

  it("(iv) created is gone (a concurrent sweep) and the sweep returned null: the stale created comes back, key omitted, no throw", async () => {
    const c = created();
    const res = await buyerCreateResponse(c, null, reader({}));
    expect(res).toBe(c);
    expect(JSON.stringify(res)).not.toMatch(/backorder/i);
  });

  it("neither row exists but the sweep returned an order: that order comes back untouched, key omitted", async () => {
    const m = { id: "o-old", lineItems: [] };
    expect(await buyerCreateResponse(created(), m, reader({}))).toBe(m);
  });

  it("(v) a lowering edit between the sweep and the re-read (lines below the overshoot): the key is omitted on the whole order", async () => {
    const read = reader({ "o-new": { ...order([li("c1", "p", 2)]), id: "o-new" } });
    expect(noKey((await buyerCreateResponse(created(), null, read)) as any)).toBe(true);
  });

  it("only null / NotFound means GONE: a real not-found on created falls through to the survivor", async () => {
    const survivor = { ...order([li("m1", "p", 8)]), id: "o-old" };
    const read = jest.fn(async (id: string) => {
      if (id === "o-new") throw new NotFoundException("Order not found");
      return id === "o-old" ? survivor : null;
    });
    const res: any = await buyerCreateResponse(created(), { id: "o-old" }, read);
    expect(res.id).toBe("o-old");
    expect(figures(res)).toEqual([3]);
  });

  it("any OTHER throw (a dropped connection, a timeout) is UNKNOWN, not gone: the sweep's order comes back untouched and the survivor is NOT read", async () => {
    const read = jest.fn(async (id: string) => {
      if (id === "o-new") throw new Error("db down");
      return { ...order([li("m1", "p", 8)]), id: "o-old" }; // would be wrongly returned if the survivor were read
    });
    const sweep = { id: "o-old", lineItems: [] };
    const res: any = await buyerCreateResponse(created(), sweep, read);
    expect(res).toBe(sweep);
    expect(noKey(res)).toBe(true);
    expect(read.mock.calls.map((c) => c[0])).toEqual(["o-new"]); // never fell through to o-old
  });

  it("a non-NotFound failure on the SURVIVOR read is unknown too: the sweep's order comes back untouched, no throw", async () => {
    const read = jest.fn(async (id: string) => {
      if (id === "o-new") throw new NotFoundException("Order not found");
      throw new Error("timeout");
    });
    const sweep = { id: "o-old", lineItems: [] };
    await expect(buyerCreateResponse(created(), sweep, read)).resolves.toBe(sweep);
  });

  it("is total: a reader that throws is never an error out of the helper (created comes back untouched)", async () => {
    const boom = jest.fn(async () => {
      throw new Error("db down");
    });
    const c = created();
    await expect(buyerCreateResponse(c, null, boom)).resolves.toBe(c);
  });

  it("a created order with no id (malformed) is unknown: returned untouched, no throw", async () => {
    const bad: any = withStockWrite({}, sw([["p", 3]]));
    await expect(buyerCreateResponse(bad, null, reader({}))).resolves.toBe(bad);
  });
});
