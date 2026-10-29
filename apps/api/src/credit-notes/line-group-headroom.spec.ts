import { readFileSync } from "fs";
import { join } from "path";
import {
  groupLines,
  pooledRefundRefusal,
  replayReturnedQty,
  type HeadroomLine,
  type LineCredit,
  type OrderPool,
} from "./line-credit-headroom";

/**
 * SA-1042 A-2 (F1): a return group is priced and capped on the same set of invoice items. A group is a product, and its order
 * line when the item names one. These are the pure halves of that: the replay of earlier returns into per-line credit, and the
 * pooled refusal, both per group. The real-Postgres proof is returns-by-line.db.spec.ts (R-r18, G-r19, G-r20).
 */
const line = (
  id: string,
  orderItemId: string | null,
  subtotal: number,
  qty: number,
  productId = "p",
): HeadroomLine => ({ id, orderItemId, productId, subtotal, qty });

// Product p on two invoices: iA is order line A (400 pcs, 90.00), iB is order line B (100 pcs, 25.00).
const iA = line("iA", "A", 90, 400);
const iB = line("iB", "B", 25, 100);
const poolOf = (credited: Array<[string, LineCredit]> = []): OrderPool => ({
  invoiceCount: 2,
  lines: [iA, iB],
  credited: new Map(credited),
});

describe("groupLines", () => {
  it("a line group is the invoice items billed from its line; a pooled group is every line of the product", () => {
    const other = line("iC", "C", 10, 10, "q");
    expect(groupLines([iA, iB, other], { productId: "p", orderItemId: "A" })).toEqual([iA]);
    expect(groupLines([iA, iB, other], { productId: "p", orderItemId: null })).toEqual([iA, iB]);
    expect(groupLines([iA, iB], { productId: "p", orderItemId: "gone" })).toEqual([]);
  });
});

describe("replayReturnedQty", () => {
  it("a return of line B is counted on B alone, even when A comes first in the pool", () => {
    const out = replayReturnedQty([iA, iB], new Map(), [
      { productId: "p", orderItemId: "B", qty: 100 },
    ]);
    expect(out.get("iB")).toMatchObject({ qty: 100, amount: 25 });
    expect(out.has("iA")).toBe(false);
  });

  it("a pooled return fills the product's lines in order, as before (no line key: the old product fill)", () => {
    const out = replayReturnedQty([iA, iB], new Map(), [
      { productId: "p", orderItemId: null, qty: 100 },
    ]);
    expect(out.get("iA")).toMatchObject({ qty: 100, amount: 23 });
    expect(out.has("iB")).toBe(false);
  });

  it("line groups replay first, then pooled groups fill what is left (the order of the input does not matter)", () => {
    const pooledFirst = [
      { productId: "p", orderItemId: null, qty: 450 },
      { productId: "p", orderItemId: "A", qty: 400 },
    ];
    const out = replayReturnedQty([iA, iB], new Map(), pooledFirst);
    expect(out.get("iA")?.qty).toBe(400); // A's own group took A whole; the pooled 450 found A full
    expect(out.get("iB")?.qty).toBeGreaterThan(0);
    expect(out.get("iB")?.qty).toBeLessThanOrEqual(100);
  });

  it("a line group whose line has no billed item counts nothing: it never falls back to the product pool", () => {
    const out = replayReturnedQty([iA, iB], new Map(), [
      { productId: "p", orderItemId: "unbilled-line", qty: 50 },
    ]);
    expect(out.size).toBe(0);
  });

  it("two items of one group are summed before they fill", () => {
    const out = replayReturnedQty([iA, iB], new Map(), [
      { productId: "p", orderItemId: "B", qty: 40 },
      { productId: "p", orderItemId: "B", qty: 60 },
    ]);
    expect(out.get("iB")?.qty).toBe(100);
  });
});

describe("pooledRefundRefusal per group (R-r18)", () => {
  // An operator credited 55.00 / 200 pcs of line A: A has 35.00 and 200 pcs left, the product 60.00 and 300 pcs.
  const credited: Array<[string, LineCredit]> = [["iA", { amount: 55, qty: 200, items: 1 }]];

  it("1 Case (200 pcs) off line A, priced 45.00, is refused on A's 35.00 though the product pool has 60.00", () => {
    expect(
      pooledRefundRefusal(poolOf(credited), { productId: "p", orderItemId: "A" }, 200),
    ).toMatchObject({ productId: "p", requestedAmount: 45, remainingAmount: 35 });
  });

  it("the same 200 pcs as a pooled group fit the product pool (46.00 of 60.00): the SA-628b average is unchanged", () => {
    expect(
      pooledRefundRefusal(poolOf(credited), { productId: "p", orderItemId: null }, 200),
    ).toBeNull();
  });

  it("a line group with no billed item on its line has nothing to refuse (priced 0, B959)", () => {
    expect(
      pooledRefundRefusal(poolOf(credited), { productId: "p", orderItemId: "gone" }, 200),
    ).toBeNull();
  });

  it("a line group still fits when the room is on its own line", () => {
    expect(
      pooledRefundRefusal(poolOf(credited), { productId: "p", orderItemId: "B" }, 100),
    ).toBeNull();
  });
});

/** Pins (OP-17): the four history terms share ONE replay helper, and the group is a required argument. */
describe("one replay, one group-shaped refusal", () => {
  const SRC = join(__dirname, "..");
  const code = (f: string) =>
    readFileSync(join(SRC, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

  it('planProductRefund( in "count" mode is called in exactly one place in line-credit-headroom.ts: the replay helper', () => {
    const src = code("credit-notes/line-credit-headroom.ts");
    expect([...src.matchAll(/planProductRefund\([\s\S]{0,120}?"count"/g)]).toHaveLength(1);
    expect([...src.matchAll(/replayReturnedQty\(/g)].length).toBeGreaterThanOrEqual(5); // def + 4 history terms
    expect(src).not.toContain("externalRefundQtyByProduct");
  });

  it("pooledRefundRefusal takes the group, never a bare product id, at both its callers", () => {
    const sig = code("credit-notes/line-credit-headroom.ts").match(
      /export function pooledRefundRefusal\(([\s\S]*?)\): RefundRefusal/,
    );
    expect(sig?.[1]).toMatch(/group: RefundGroup,/);
    expect(code("credit-notes/credit-notes.service.ts")).toMatch(
      /pooledRefundRefusal\(pool, group, r\.qty\)/,
    );
    expect(code("returns/returns.service.ts")).toMatch(/pooledRefundRefusal\(pool, group, qty\)/);
  });
});
