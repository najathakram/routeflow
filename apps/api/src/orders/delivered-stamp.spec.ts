import { clearUnevidencedDelivered, hasDeliveryEvidence } from "./delivered-stamp";

// SA-762r: the counter-sale void's hand-over reset. Pure logic over a stand-in tx; the real-DB twin is case (i) of
// counter-sale/counter-sale-void.db.spec.ts.
function tx(opts: {
  routeRunStopId?: string | null;
  orderMissing?: boolean;
  handed?: string[];
  mutations?: Array<{ orderItemId: string | null; type: string; quantityDelivered: unknown }>;
}) {
  return {
    order: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.orderMissing ? null : { routeRunStopId: opts.routeRunStopId ?? null },
        ),
    },
    orderItem: {
      findMany: jest.fn().mockResolvedValue((opts.handed ?? []).map((id) => ({ id }))),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    deliveryMutation: { findMany: jest.fn().mockResolvedValue(opts.mutations ?? []) },
  };
}

describe("clearUnevidencedDelivered", () => {
  it("zeroes deliveredQty on the delivered lines that have no evidence, in one write scoped to the order", async () => {
    const t = tx({ handed: ["l1", "l2"] });
    await expect(clearUnevidencedDelivered(t, "o1")).resolves.toEqual(["l1", "l2"]);
    expect(t.orderItem.updateMany).toHaveBeenCalledTimes(1);
    expect(t.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["l1", "l2"] }, orderId: "o1" },
      data: { deliveredQty: 0 },
    });
    expect(t.orderItem.findMany).toHaveBeenCalledWith({
      where: { orderId: "o1", deliveredQty: { gt: 0 }, status: { not: "CANCELLED" } },
      select: { id: true },
    });
  });

  it("leaves a line with a qualifying evidence row (REFUSED counts) untouched", async () => {
    const t = tx({
      handed: ["l1", "l2", "l3"],
      mutations: [
        { orderItemId: "l2", type: "DELIVERED", quantityDelivered: 3 },
        { orderItemId: "l3", type: "REFUSED", quantityDelivered: 0 },
      ],
    });
    await expect(clearUnevidencedDelivered(t, "o1")).resolves.toEqual(["l1"]);
    expect(t.orderItem.updateMany.mock.calls[0][0].where.id).toEqual({ in: ["l1"] });
  });

  it("a row of a non-evidence type, or with no quantityDelivered, is not evidence", async () => {
    const t = tx({
      handed: ["l1", "l2"],
      mutations: [
        { orderItemId: "l1", type: "ADD_ON", quantityDelivered: 2 },
        { orderItemId: "l2", type: "DELIVERED", quantityDelivered: null },
      ],
    });
    await expect(clearUnevidencedDelivered(t, "o1")).resolves.toEqual(["l1", "l2"]);
  });

  it("an order that rode a route stop is not touched at all (no line read, no write)", async () => {
    const t = tx({ routeRunStopId: "stop-1", handed: ["l1"] });
    await expect(clearUnevidencedDelivered(t, "o1")).resolves.toEqual([]);
    expect(t.orderItem.findMany).not.toHaveBeenCalled();
    expect(t.orderItem.updateMany).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing reads delivered (today's counter sale) or the order is gone", async () => {
    const none = tx({ handed: [] });
    await expect(clearUnevidencedDelivered(none, "o1")).resolves.toEqual([]);
    expect(none.deliveryMutation.findMany).not.toHaveBeenCalled();
    expect(none.orderItem.updateMany).not.toHaveBeenCalled();
    const gone = tx({ orderMissing: true, handed: ["l1"] });
    await expect(clearUnevidencedDelivered(gone, "o1")).resolves.toEqual([]);
    expect(gone.orderItem.updateMany).not.toHaveBeenCalled();
  });

  it("every handed line has evidence: no write", async () => {
    const t = tx({
      handed: ["l1"],
      mutations: [{ orderItemId: "l1", type: "PARTIAL", quantityDelivered: 1 }],
    });
    await expect(clearUnevidencedDelivered(t, "o1")).resolves.toEqual([]);
    expect(t.orderItem.updateMany).not.toHaveBeenCalled();
  });
});

describe("hasDeliveryEvidence", () => {
  it("is membership in the evidence reader's per-line map", () => {
    const basis = { hasMutations: true, byLineId: new Map([["l1", 2]]) };
    expect(hasDeliveryEvidence(basis, "l1")).toBe(true);
    expect(hasDeliveryEvidence(basis, "l2")).toBe(false);
  });
});
