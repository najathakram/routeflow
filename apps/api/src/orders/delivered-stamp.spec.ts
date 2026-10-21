import { makeStampDb } from "../common/testing/delivered-stamp-fake-db";
import {
  captureRecreatedCarry,
  clearUnevidencedDelivered,
  heldAtBookedFloor,
  hasDeliveryEvidence,
  markSaleDelivered,
  stampDeliveredInFull,
} from "./delivered-stamp";

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

  it("a routeRunStopId handed in by the caller (the void's locked row) saves the order re-read", async () => {
    const t = tx({ handed: ["l1"] });
    await expect(clearUnevidencedDelivered(t, "o1", null)).resolves.toEqual(["l1"]);
    expect(t.order.findUnique).not.toHaveBeenCalled();
    const route = tx({ handed: ["l1"] });
    await expect(clearUnevidencedDelivered(route, "o1", "stop-1")).resolves.toEqual([]);
    expect(route.order.findUnique).not.toHaveBeenCalled();
    expect(route.orderItem.findMany).not.toHaveBeenCalled();
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

/**
 * SA-763r R6 / M2 (red rows 4, 5): the evidence-safe stamp. Entry mode raises a DELIVERED order's
 * deliveredQty to qty on lines with NO qualifying DeliveryMutation row, and touches nothing else.
 */
const stamp = (db: ReturnType<typeof makeStampDb>) =>
  db.prisma.tenantTransaction((tx: any) => stampDeliveredInFull(tx, "o1", "entry"));

describe("stampDeliveredInFull — entry", () => {
  it("raises every no-row active line to its qty (0 -> qty)", async () => {
    const db = makeStampDb({
      lines: [
        { id: "a", qty: 10, deliveredQty: 0 },
        { id: "b", qty: 2.5, deliveredQty: 0 },
      ],
    });
    expect(await stamp(db)).toBe(2);
    expect(db.line("a").deliveredQty).toBe(10);
    expect(db.line("b").deliveredQty).toBe(2.5);
  });

  it("never lowers a recorded delivery (qty < delivered stays)", async () => {
    const db = makeStampDb({ lines: [{ id: "a", qty: 4, deliveredQty: 10 }] });
    expect(await stamp(db)).toBe(0);
    expect(db.line("a").deliveredQty).toBe(10);
    expect(db.calls.lineWrites).toBe(0);
  });

  it("keeps a larger recorded delivery and raises only a smaller one (max)", async () => {
    const db = makeStampDb({
      lines: [
        { id: "a", qty: 10, deliveredQty: 3 },
        { id: "b", qty: 10, deliveredQty: 12 },
      ],
    });
    await stamp(db);
    expect(db.line("a").deliveredQty).toBe(10);
    expect(db.line("b").deliveredQty).toBe(12);
  });

  it("leaves a short-delivered route line (it has rows) exactly as the evidence left it", async () => {
    const db = makeStampDb({
      lines: [
        { id: "route", qty: 10, deliveredQty: 6 },
        { id: "manual", qty: 5, deliveredQty: 0 },
      ],
      mutations: [
        { orderItemId: "route", type: "PARTIAL", quantityDelivered: 6, routeRunStopId: "stop-1" },
      ],
    });
    await stamp(db);
    expect(db.line("route").deliveredQty).toBe(6); // route-evidence line: untouched
    expect(db.line("manual").deliveredQty).toBe(5); // no rows: stamped
  });

  it("a REFUSED row (quantityDelivered 0) is evidence too: that line stays at 0", async () => {
    const db = makeStampDb({
      lines: [{ id: "refused", qty: 3, deliveredQty: 0 }],
      mutations: [{ orderItemId: "refused", type: "REFUSED", quantityDelivered: 0 }],
    });
    await stamp(db);
    expect(db.line("refused").deliveredQty).toBe(0);
  });

  it("a row with no delivered quantity (a change-request tag) is not evidence", async () => {
    const db = makeStampDb({
      lines: [{ id: "a", qty: 3, deliveredQty: 0 }],
      mutations: [{ orderItemId: "a", type: "ADD_ON", quantityDelivered: null }],
    });
    await stamp(db);
    expect(db.line("a").deliveredQty).toBe(3);
  });

  it("never touches an order with a routeRunStopId", async () => {
    const db = makeStampDb({
      routeRunStopId: "stop-1",
      lines: [{ id: "a", qty: 10, deliveredQty: 0 }],
    });
    expect(await stamp(db)).toBe(0);
    expect(db.line("a").deliveredQty).toBe(0);
  });

  it("skips CANCELLED lines", async () => {
    const db = makeStampDb({
      lines: [
        { id: "live", qty: 2, deliveredQty: 0 },
        { id: "dead", qty: 9, deliveredQty: 0, status: "CANCELLED" },
      ],
    });
    await stamp(db);
    expect(db.line("live").deliveredQty).toBe(2);
    expect(db.line("dead").deliveredQty).toBe(0);
  });

  it("is idempotent: a second run writes nothing", async () => {
    const db = makeStampDb({ lines: [{ id: "a", qty: 7, deliveredQty: 0 }] });
    await stamp(db);
    db.calls.lineWrites = 0;
    expect(await stamp(db)).toBe(0);
    expect(db.calls.lineWrites).toBe(0);
  });
});

describe("markSaleDelivered — the counter sale's DELIVERED write", () => {
  it("writes status, deliveredAt and the stamp in one transaction", async () => {
    const db = makeStampDb({ lines: [{ id: "a", qty: 3, deliveredQty: 0 }] });
    const at = new Date("2026-10-01T10:00:00Z");
    await markSaleDelivered(db.prisma, "o1", at);
    expect(db.committed.order).toMatchObject({ status: "DELIVERED", deliveredAt: at });
    expect(db.line("a").deliveredQty).toBe(3);
    expect(db.calls.txCount).toBe(1);
  });

  it("a failure after the status write rolls the status back too", async () => {
    const db = makeStampDb({
      lines: [{ id: "a", qty: 3, deliveredQty: 0 }],
      failAfterStatusWrite: true,
    });
    await expect(markSaleDelivered(db.prisma, "o1", new Date())).rejects.toThrow("boom");
    expect(db.committed.order.status).toBe("CONFIRMED");
    expect(db.line("a").deliveredQty).toBe(0);
  });
});

describe("stampDeliveredInFull — edit (per-line increase of a DELIVERED order)", () => {
  const edit = (db: ReturnType<typeof makeStampDb>, held: Array<{ id: string; qty: number }>) =>
    db.prisma.tenantTransaction((tx: any) =>
      stampDeliveredInFull(
        tx,
        "o1",
        "edit",
        held.map((h) => ({ ...h, productId: "p" })),
      ),
    );

  it("a raise lifts d to the new qty (+2 on a stamped line: 10 -> 12)", async () => {
    const db = makeStampDb({
      status: "DELIVERED",
      lines: [{ id: "a", qty: 12, deliveredQty: 10 }],
    });
    await edit(db, [{ id: "a", qty: 10 }]);
    expect(db.line("a").deliveredQty).toBe(12);
  });

  it("a cut never lowers d, and a raise inside the booked floor does not move it (12, cut to 10, raise to 11)", async () => {
    const db = makeStampDb({
      status: "DELIVERED",
      lines: [{ id: "a", qty: 10, deliveredQty: 12 }],
    });
    await edit(db, [{ id: "a", qty: 12 }]); // the cut: held 12 -> now 10
    expect(db.line("a").deliveredQty).toBe(12);
    db.line("a").qty = 11;
    await edit(db, [{ id: "a", qty: 10 }]); // the raise: held 10 -> now 11
    expect(db.line("a").deliveredQty).toBe(12); // stays at the floor: no stock moves
    db.line("a").qty = 14;
    await edit(db, [{ id: "a", qty: 11 }]); // raise beyond the floor
    expect(db.line("a").deliveredQty).toBe(14);
  });

  it("a legacy line (d 0, never stamped) is normalised to max(oldQty, newQty) on its first edit", async () => {
    const db = makeStampDb({
      status: "DELIVERED",
      lines: [
        { id: "a", qty: 12, deliveredQty: 0 },
        { id: "b", qty: 5, deliveredQty: 0 }, // an untouched legacy line is normalised too
      ],
    });
    await edit(db, [
      { id: "a", qty: 10 },
      { id: "b", qty: 5 },
    ]);
    expect(db.line("a").deliveredQty).toBe(12);
    expect(db.line("b").deliveredQty).toBe(5);
    // then a cut to 5 restocks nothing: the booked floor is the 12 that left
    db.line("a").qty = 5;
    await edit(db, [{ id: "a", qty: 12 }]);
    expect(db.line("a").deliveredQty).toBe(12);
  });

  it("an added line (not held) is delivered in full", async () => {
    const db = makeStampDb({
      status: "DELIVERED",
      lines: [{ id: "new", qty: 3, deliveredQty: 0 }],
    });
    await edit(db, []);
    expect(db.line("new").deliveredQty).toBe(3);
  });

  it("a route short line that is edited stays exactly as its evidence left it", async () => {
    const db = makeStampDb({
      status: "DELIVERED",
      lines: [{ id: "route", qty: 12, deliveredQty: 6 }],
      mutations: [{ orderItemId: "route", type: "PARTIAL", quantityDelivered: 6 }],
    });
    await edit(db, [{ id: "route", qty: 10 }]);
    expect(db.line("route").deliveredQty).toBe(6);
  });

  it("does nothing unless the order is DELIVERED (read under the caller's lock)", async () => {
    const db = makeStampDb({ status: "CONFIRMED", lines: [{ id: "a", qty: 12, deliveredQty: 0 }] });
    expect(await edit(db, [{ id: "a", qty: 10 }])).toBe(0);
    expect(db.line("a").deliveredQty).toBe(0);
  });
});

describe("stampDeliveredInFull — recreated (replace-all, M2)", () => {
  const held = (rows: Array<[string, string | null, number, number]>) =>
    rows.map(([id, productId, qty, deliveredQty]) => ({ id, productId, qty, deliveredQty }));
  const recreate = async (
    db: ReturnType<typeof makeStampDb>,
    pre: ReturnType<typeof held>,
    evidence: string[] = [],
  ) => {
    const carry = await captureRecreatedCarry(
      {
        order: { findFirst: async () => ({ ...db.committed.order }) },
        deliveryMutation: {
          findMany: async () =>
            evidence.map((orderItemId) => ({
              orderItemId,
              type: "PARTIAL",
              quantityDelivered: 1,
            })),
        },
      } as never,
      "o1",
      pre,
    );
    return db.prisma.tenantTransaction((tx: any) =>
      stampDeliveredInFull(tx, "o1", "recreated", carry!),
    );
  };

  it("carries the per-product delivered sum onto the recreated row, then max(carried, qty)", async () => {
    const db = makeStampDb({
      status: "DELIVERED",
      lines: [{ id: "n1", productId: "p1", qty: 12, deliveredQty: 0 }],
    });
    await recreate(db, held([["old1", "p1", 10, 10]]));
    expect(db.line("n1").deliveredQty).toBe(12);
  });

  it("a product cut below what was delivered keeps the carried value (never lowered)", async () => {
    const db = makeStampDb({
      status: "DELIVERED",
      lines: [{ id: "n1", productId: "p1", qty: 6, deliveredQty: 0 }],
    });
    await recreate(db, held([["old1", "p1", 10, 10]]));
    expect(db.line("n1").deliveredQty).toBe(10);
  });

  it("REFUSES a replace-all of a DELIVERED order that has any evidence row: 409 before anything is deleted", async () => {
    const db = makeStampDb({
      status: "DELIVERED",
      lines: [{ id: "n1", productId: "p1", qty: 10, deliveredQty: 0 }],
    });
    await expect(recreate(db, held([["old1", "p1", 10, 6]]), ["old1"])).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ORDER_EDIT_NEEDS_LINE_IDS" }),
    });
  });

  it("refuses even when the evidence row sits on an order that rode a route stop", async () => {
    const db = makeStampDb({
      status: "DELIVERED",
      routeRunStopId: "stop-1",
      lines: [{ id: "n1", productId: "p1", qty: 10, deliveredQty: 0 }],
    });
    await expect(recreate(db, held([["old1", "p1", 10, 8]]), ["old1"])).rejects.toMatchObject({
      response: expect.objectContaining({ code: "ORDER_EDIT_NEEDS_LINE_IDS" }),
    });
  });

  it("splits the carried sum over a product's recreated rows, in order, losing none of it", async () => {
    const db = makeStampDb({
      status: "DELIVERED",
      lines: [
        { id: "n1", productId: "p1", qty: 3, deliveredQty: 0 },
        { id: "n2", productId: "p1", qty: 3, deliveredQty: 0 },
      ],
    });
    await recreate(db, held([["old1", "p1", 8, 8]]));
    expect(db.line("n1").deliveredQty).toBe(3);
    expect(db.line("n2").deliveredQty).toBe(5); // the last row takes the rest: 3 + 5 = 8 carried
  });

  it("a product that is new in the edit is delivered in full; an unlisted line too", async () => {
    const db = makeStampDb({
      status: "DELIVERED",
      lines: [
        { id: "n1", productId: "p9", qty: 3, deliveredQty: 0 },
        { id: "u1", productId: null, qty: 2, deliveredQty: 0 },
      ],
    });
    await recreate(db, held([["old1", "p1", 10, 10]]));
    expect(db.line("n1").deliveredQty).toBe(3);
    expect(db.line("u1").deliveredQty).toBe(2);
  });

  it("captures nothing for an order that is not DELIVERED", async () => {
    const db = makeStampDb({ status: "CONFIRMED", lines: [] });
    const carry = await captureRecreatedCarry(
      { order: { findFirst: async () => ({ ...db.committed.order }) } } as never,
      "o1",
      [],
    );
    expect(carry).toBeNull();
  });
});

describe("the carry and the settle input leave a CANCELLED line out", () => {
  const dbOf = (
    mutations: Array<{ orderItemId: string; type: string; quantityDelivered: number }> = [],
  ) =>
    makeStampDb({
      status: "DELIVERED",
      lines: [{ id: "l1", productId: "p1", qty: 10, deliveredQty: 0 }],
      mutations,
    });

  it("a legacy CANCELLED row with qty > 0 does not inflate the recreated carry", async () => {
    const db = dbOf();
    const carry = await captureRecreatedCarry(
      {
        order: { findFirst: async () => ({ ...db.committed.order }) },
        deliveryMutation: { findMany: async () => [] },
      } as never,
      "o1",
      [
        { id: "old1", productId: "p1", qty: 10, deliveredQty: 0, status: "PENDING" },
        { id: "old2", productId: "p1", qty: 5, deliveredQty: 0, status: "CANCELLED" },
      ],
    );
    // 10 for the live legacy line, 0 for the cancelled one: red before the guard (15 for the product)
    expect(carry!.held.map((h) => h.deliveredQty)).toEqual([10, 0]);
  });

  it("heldAtBookedFloor leaves a CANCELLED line's delivered quantity as stored", async () => {
    const db = dbOf();
    const out = await db.prisma.tenantTransaction((tx: any) =>
      heldAtBookedFloor(tx, "o1", [
        { id: "a", productId: "p1", qty: 10, deliveredQty: 0, status: "PENDING" },
        { id: "b", productId: "p1", qty: 5, deliveredQty: 0, status: "CANCELLED" },
      ]),
    );
    expect(out.map((h) => h.deliveredQty)).toEqual([10, 0]);
  });
});

describe("heldAtBookedFloor — the settle input", () => {
  const held = (rows: Array<[string, number, number]>) =>
    rows.map(([id, qty, deliveredQty]) => ({ id, productId: "p1", qty, deliveredQty }));
  const feed = (db: ReturnType<typeof makeStampDb>, rows: ReturnType<typeof held>) =>
    db.prisma.tenantTransaction((tx: any) => heldAtBookedFloor(tx, "o1", rows));

  it("a line WITH evidence rows on a non-route DELIVERED order is left exactly as recorded", async () => {
    const db = makeStampDb({
      status: "DELIVERED",
      lines: [
        { id: "route", qty: 10, deliveredQty: 6 },
        { id: "legacy", qty: 4, deliveredQty: 0 },
      ],
      mutations: [{ orderItemId: "route", type: "PARTIAL", quantityDelivered: 6 }],
    });
    const rows = held([
      ["route", 10, 6],
      ["legacy", 4, 0],
    ]);
    const out = await feed(db, rows);
    expect(out[0]).toBe(rows[0]); // the evidence line is the SAME object: d 6 untouched
    expect(out[0].deliveredQty).toBe(6);
    expect(out[1].deliveredQty).toBe(4); // the no-record line is fed at its booked floor
    expect(rows[1].deliveredQty).toBe(0); // the caller's rows are never mutated
  });

  it("returns the rows unchanged unless the order is DELIVERED and non-route", async () => {
    const rows = held([["a", 10, 0]]);
    expect(await feed(makeStampDb({ status: "CONFIRMED", lines: [] }), rows)).toBe(rows);
    expect(
      await feed(makeStampDb({ status: "DELIVERED", routeRunStopId: "s1", lines: [] }), rows),
    ).toBe(rows);
  });
});
