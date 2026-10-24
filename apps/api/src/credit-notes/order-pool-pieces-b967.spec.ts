/**
 * B967: the order pool's refund pre-check works in PIECES. A STANDARD return's qty is in the order line's own selling unit
 * (boxes for a boxed line); the pool's lines count boxes too, but the credited items and the `pooledRefund` handed to the
 * mint are checked as pieces, so the pre-check converts each line with its own `piecesPerQty` and takes PIECES in.
 */
import { pooledRefundRefusal, pooledTakeRefusal, type OrderPool } from "./line-credit-headroom";

const boxPool = (credited: Record<string, { qty: number; amount: number }> = {}): OrderPool => ({
  invoiceCount: 2,
  lines: [
    { id: "a", productId: "p", subtotal: 120, qty: 1, piecesPerQty: 12 }, // 1 box of 12, older invoice
    { id: "b", productId: "p", subtotal: 120, qty: 1, piecesPerQty: 12 }, // 1 box of 12, newer invoice
  ],
  credited: new Map(Object.entries(credited)),
});

describe("pooledRefundRefusal — PIECES (B967)", () => {
  it("a 12-per-box product with 6 pieces credited has 18 pieces of room, not 1.5", () => {
    const pool = boxPool({ a: { qty: 0.5, amount: 60 } }); // a credit note item for 6 pieces
    expect(pooledRefundRefusal(pool, "p", 18)).toBeNull(); // exactly the room, in pieces
    expect(pooledRefundRefusal(pool, "p", 19)).toMatchObject({
      remainingQty: 18,
      requestedQty: 19,
      qtyUnit: "pieces",
    });
  });

  it("a standard return of 2 boxes (24 pieces) is refused against 18 pieces of room", () => {
    const pool = boxPool({ a: { qty: 0.5, amount: 60 } });
    expect(pooledRefundRefusal(pool, "p", 2 * 12)).not.toBeNull();
    expect(pooledRefundRefusal(pool, "p", 1.5 * 12)).toBeNull(); // 1.5 boxes fits exactly
  });

  it("preview and mint agree: the refund check and the take check give the same verdict", () => {
    const pool = boxPool({ a: { qty: 0.5, amount: 60 } });
    for (const pieces of [6, 18, 18.5, 24]) {
      const refund = pooledRefundRefusal(pool, "p", pieces);
      const take = pooledTakeRefusal(pool, "p", { amount: (pieces * 10) as number, qty: pieces });
      expect(Boolean(refund)).toBe(Boolean(take));
    }
  });

  it("loose (single-piece) lines are unchanged", () => {
    const pool: OrderPool = {
      invoiceCount: 2,
      lines: [
        { id: "a", productId: "p", subtotal: 50, qty: 10 },
        { id: "b", productId: "p", subtotal: 50, qty: 10, piecesPerQty: 1 },
      ],
      credited: new Map([["a", { qty: 4, amount: 20 }]]),
    };
    expect(pooledRefundRefusal(pool, "p", 16)).toBeNull();
    expect(pooledRefundRefusal(pool, "p", 17)).not.toBeNull();
  });

  it("keeps the rounding rule: 1.8333 boxes of room is 22 pieces, not 21.996", () => {
    const pool: OrderPool = {
      invoiceCount: 2,
      lines: [{ id: "a", productId: "p", subtotal: 120, qty: 2, piecesPerQty: 12 }],
      credited: new Map([["a", { qty: 0.16667, amount: 10 }]]),
    };
    expect(pooledRefundRefusal(pool, "p", 22)).toBeNull();
  });
});
