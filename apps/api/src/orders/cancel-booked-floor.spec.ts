// The harness FIRST: it jest.mock()s modules that orders.service also imports.
import { buildOrdersService } from "./testing/orders-service-harness";
import { bookedPieces } from "./order-stock";
import { unevidencedDeliveredFloor } from "./delivered-stamp";

/**
 * SA-763r review HIGH: a counter sale of 12 books 12 out and is stamped d = 12. An office cut to 10 moves no stock
 * (stock books max(qty, d) = 12 either way) and leaves d = 12. The void zeroes d and the cancel credits max(10, 0) =
 * 10, so 2 units were lost on a fully voided sale. The void now hands the cancel the units it zeroed
 * (`bookedFloor`): the credit is made on max(qty, floor), the counter ends where it started.
 */
const ORDER = { id: "ord-1", customerId: "cust-1", orderNumber: "ORD-1", status: "DELIVERED" };
const line = (over: Record<string, unknown> = {}) => ({
  id: "l1",
  productId: "prod-1",
  qty: 10,
  deliveredQty: 0, // the hand-over reset already zeroed it
  status: "PENDING",
  unitsPerBox: null,
  boxes: null,
  pieces: null,
  unitLabel: null,
  ...over,
});

describe("cancelOrderInTx: the stock credit honours the booked floor (counter sale 12, cut to 10, void)", () => {
  async function cancel(items: unknown[], bookedFloor?: Map<string, number>, unitsPerBox = null) {
    const h = await buildOrdersService();
    const { prisma } = h;
    prisma.order.findUnique.mockResolvedValue(ORDER);
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.orderItem.findMany.mockResolvedValue(items as never);
    prisma.product.findMany.mockResolvedValue([
      { id: "prod-1", name: "Tomatoes", currentStock: 88, unitsPerBox },
    ] as never);
    prisma.product.update.mockResolvedValue({ id: "prod-1", currentStock: 100 } as never);
    await prisma.tenantTransaction((tx: any) =>
      h.service.cancelOrderInTx(tx, { id: "ord-1" }, {
        fromStatuses: ["DELIVERED"],
        statusUpdateData: { status: "CANCELLED" },
        carrier: null,
        user: { sub: "u", role: "OPERATOR", tenantId: "t" },
        notes: "CANCEL",
        bookedFloor,
        skipDeliveryStateCheck: true, // this spec pins the stock credit, not the SA-814h guard
      } as never),
    );
    return prisma.product.update.mock.calls.map((c) => (c[0] as any).data.currentStock.increment);
  }

  it("credits all 12 booked units when the cut left qty 10 and the floor was 12", async () => {
    expect(await cancel([line()], new Map([["l1", 12]]))).toEqual([12]); // red on base: [10]
  });

  it("no cut (qty 12, floor 12): 12 back", async () => {
    expect(await cancel([line({ qty: 12 })], new Map([["l1", 12]]))).toEqual([12]);
  });

  it("a floor below qty (a raised line) never lowers the credit", async () => {
    expect(await cancel([line({ qty: 14 })], new Map([["l1", 12]]))).toEqual([14]);
  });

  it("no floor (the office cancel): unchanged, qty back", async () => {
    expect(await cancel([line()])).toEqual([10]);
  });

  it("a box-unaware boxed line (qty in boxes, pack 6): 3 boxes booked, cut to 2, back = 3 x 6 pieces", async () => {
    expect(await cancel([line({ qty: 2 })], new Map([["l1", 3]]), 6 as never)).toEqual([18]);
  });

  it("a box-split line (qty already in pieces): the floor is in pieces too", async () => {
    expect(await cancel([line({ qty: 20, boxes: 1, pieces: 8 })], new Map([["l1", 26]]))).toEqual([
      26,
    ]);
  });
});

describe("the arithmetic behind it (bookedPieces)", () => {
  const out = (qty: number, d: number) => {
    const b = bookedPieces(
      [{ id: "l1", productId: "p", qty, deliveredQty: d, boxes: null }] as never,
      [],
      undefined,
      "stable",
    );
    return b.before - b.after; // pieces the counter holds out for the line and the cancel can return
  };
  it("a cut that leaves qty < d holds max(qty, d) out; the clear alone returns only qty", () => {
    expect(out(10, 12)).toBe(0); // with d kept the cancel returns nothing: the delivered units stay booked
    expect(out(10, 0)).toBe(10); // after the clear: qty only, 2 short of the 12 booked out
    expect(out(12, 0)).toBe(12);
  });
});

describe("unevidencedDeliveredFloor", () => {
  const tx = (o: {
    routeRunStopId?: string | null;
    gone?: boolean;
    handed?: Array<{ id: string; deliveredQty: unknown }>;
    evidence?: string[];
  }) => ({
    order: {
      findUnique: jest
        .fn()
        .mockResolvedValue(o.gone ? null : { routeRunStopId: o.routeRunStopId ?? null }),
    },
    orderItem: { findMany: jest.fn().mockResolvedValue(o.handed ?? []) },
    deliveryMutation: {
      findMany: jest.fn().mockResolvedValue(
        (o.evidence ?? []).map((orderItemId) => ({
          orderItemId,
          type: "PARTIAL",
          quantityDelivered: 1,
        })),
      ),
    },
  });

  it("maps each no-evidence delivered line to its deliveredQty and skips evidenced ones", async () => {
    const t = tx({
      handed: [
        { id: "a", deliveredQty: "12" },
        { id: "b", deliveredQty: 5 },
      ],
      evidence: ["b"],
    });
    expect(await unevidencedDeliveredFloor(t, "o1")).toEqual(new Map([["a", 12]]));
  });

  it("is empty for a route-stop order, a missing order, or nothing delivered (no evidence read)", async () => {
    expect((await unevidencedDeliveredFloor(tx({ routeRunStopId: "s" }), "o1")).size).toBe(0);
    expect((await unevidencedDeliveredFloor(tx({ gone: true }), "o1")).size).toBe(0);
    const none = tx({ handed: [] });
    expect((await unevidencedDeliveredFloor(none, "o1")).size).toBe(0);
    expect(none.deliveryMutation.findMany).not.toHaveBeenCalled();
  });
});
