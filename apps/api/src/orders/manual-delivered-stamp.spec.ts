import { OrderStatus } from "@prisma/client";
import { makeStampDb } from "../common/testing/delivered-stamp-fake-db";
import { cancelImpact } from "./order-cancel-impact";
import { updateStatusWithShipMarker } from "./order-ship-state";
import { buildStatusUpdateData } from "./order-status-claim";
import { bookedPieces } from "./order-stock";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

/**
 * SA-763r R6 (B692), red rows 4 / 5 / 7 through the REAL entry points. Before the stamp a manual
 * DELIVERED (changeStatus, a pickup hand-over's changeStatus, a counter sale) wrote only the status: the
 * line read "nothing delivered", a later qty cut restocked goods the customer holds, and a delivered
 * order could be cancelled. The state-based cases use an in-memory store that rolls back like a tx.
 */
const order = (db: ReturnType<typeof makeStampDb>, fulfillPath = "ROUTE") => ({
  id: "o1",
  tenantId: "t1",
  status: db.committed.order.status as OrderStatus,
  fulfillPath: fulfillPath as never,
  subtotal: 10,
  tax: 0,
  total: 10,
  deliveredAt: null,
  orderDate: null,
  shippedAt: null,
  notes: null,
});
const deliver = (db: ReturnType<typeof makeStampDb>, from: OrderStatus, path = "ROUTE") =>
  updateStatusWithShipMarker(
    { prisma: db.prisma },
    { ...order(db, path), status: from },
    { status: OrderStatus.DELIVERED },
    undefined,
    buildStatusUpdateData(order(db, path) as never, OrderStatus.DELIVERED, {
      isDeliveredDemotion: false,
    }),
  );

const lineBooked = (qtyBefore: number, qtyAfter: number, d: number) => {
  const r = bookedPieces(
    [{ id: "a", productId: "p1", qty: qtyBefore, deliveredQty: d, boxes: null }] as never,
    [{ id: "a", productId: "p1", qty: qtyAfter, boxes: null }] as never,
    undefined,
    "stable",
  );
  return r.after - r.before; // negative = stock returned to the shelf
};

describe("(4) a manual DELIVERED on a no-row line books what left", () => {
  it("changeStatus's write: deliveredQty 0 -> qty, status and stamp committed together", async () => {
    const db = makeStampDb({
      status: "CONFIRMED",
      lines: [
        { id: "a", qty: 10, deliveredQty: 0 },
        { id: "b", qty: 4, deliveredQty: 0 },
      ],
    });
    await deliver(db, OrderStatus.CONFIRMED);
    expect(db.committed.order.status).toBe("DELIVERED");
    expect(db.line("a").deliveredQty).toBe(10); // red on base: 0
    expect(db.line("b").deliveredQty).toBe(4);
  });

  it("then a qty cut returns nothing to the shelf (the goods are gone)", async () => {
    const db = makeStampDb({ status: "CONFIRMED", lines: [{ id: "a", qty: 10, deliveredQty: 0 }] });
    expect(lineBooked(10, 6, db.line("a").deliveredQty)).toBe(-4); // before the hand-over: restocks 4
    await deliver(db, OrderStatus.CONFIRMED);
    expect(lineBooked(10, 6, db.line("a").deliveredQty)).toBe(0); // red on base: -4
  });

  it("a PICKUP hand-over takes the same path (pickup-complete runs changeStatus DELIVERED)", async () => {
    const h = await buildOrdersService();
    const row = {
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-1",
      status: "CONFIRMED",
      fulfillPath: "PICKUP",
      routeRunId: null,
      routeRunStopId: null,
      total: 10,
      deliveredAt: null,
      orderDate: new Date("2026-10-04T12:00:00Z"),
      customer: { businessName: "Acme Co" },
    };
    h.prisma.order.findUnique.mockResolvedValue(row);
    h.prisma.order.findFirst.mockResolvedValue({ routeRunStopId: null });
    h.prisma.order.update.mockResolvedValue({ ...row, status: "DELIVERED" });
    h.prisma.orderItem.findMany.mockResolvedValue([{ id: "li-1", qty: 6, deliveredQty: 0 }]);
    h.prisma.deliveryMutation.findMany.mockResolvedValue([]);
    await h.service.changeStatus(
      "ord-1",
      { status: "DELIVERED" as never },
      operatorPayload as never,
    );
    expect(h.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: "li-1" },
      data: { deliveredQty: 6 },
    });
  });

  it("a counter sale (createSale deliveredNow) stamps the lines in its DELIVERED write", async () => {
    const h = await buildOrdersService();
    jest.spyOn(h.service, "create").mockResolvedValue({
      id: "ord-1",
      customerId: "c1",
      orderNumber: "O1",
      status: "PENDING",
    } as never);
    h.prisma.order.findFirst.mockResolvedValue({ routeRunStopId: null });
    h.prisma.orderItem.findMany.mockResolvedValue([
      { id: "li-1", qty: 2, deliveredQty: 0 },
      { id: "li-2", qty: 3, deliveredQty: 0 },
    ]);
    h.prisma.deliveryMutation.findMany.mockResolvedValue([]);
    await h.service.createSale(
      { customerId: "c1", items: [{ productId: "p1", qty: 2 }], deliveredNow: true } as never,
      operatorPayload as never,
      { counterSale: true, fulfillPath: "PICKUP" as never },
    );
    expect(h.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: "li-1" },
      data: { deliveredQty: 2 },
    });
    expect(h.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: "li-2" },
      data: { deliveredQty: 3 },
    });
  });
});

describe("(5) evidence guards", () => {
  it("a short-delivered route line (rows) -> manual PARTIALLY -> DELIVERED: evidence unchanged", async () => {
    const db = makeStampDb({
      status: "PARTIALLY_DELIVERED",
      lines: [
        { id: "route", qty: 10, deliveredQty: 6 },
        { id: "extra", qty: 2, deliveredQty: 0 },
      ],
      mutations: [{ orderItemId: "route", type: "PARTIAL", quantityDelivered: 6 }],
    });
    await deliver(db, OrderStatus.PARTIALLY_DELIVERED);
    expect(db.line("route").deliveredQty).toBe(6);
    expect(db.line("extra").deliveredQty).toBe(2);
    expect(db.committed.mutations).toHaveLength(1); // no evidence row is ever written from here
  });

  it("qty < delivered: the stamp never lowers the recorded delivery", async () => {
    const db = makeStampDb({ status: "CONFIRMED", lines: [{ id: "a", qty: 4, deliveredQty: 10 }] });
    await deliver(db, OrderStatus.CONFIRMED);
    expect(db.line("a").deliveredQty).toBe(10);
  });

  it("an order with a routeRunStopId is untouched", async () => {
    const db = makeStampDb({
      status: "CONFIRMED",
      routeRunStopId: "stop-1",
      lines: [{ id: "a", qty: 10, deliveredQty: 0 }],
    });
    await deliver(db, OrderStatus.CONFIRMED);
    expect(db.committed.order.status).toBe("DELIVERED");
    expect(db.line("a").deliveredQty).toBe(0);
  });
});

describe("(7) manual DELIVERED -> reopen -> cancel-impact", () => {
  it("the reopen keeps the stamp, so cancel-impact refuses the cancel (use a Return)", async () => {
    const db = makeStampDb({ status: "CONFIRMED", lines: [{ id: "a", qty: 10, deliveredQty: 0 }] });
    await deliver(db, OrderStatus.CONFIRMED);
    await updateStatusWithShipMarker(
      { prisma: db.prisma },
      { ...order(db), status: OrderStatus.DELIVERED },
      { status: OrderStatus.CONFIRMED, reason: "oops" },
      undefined,
      buildStatusUpdateData(order(db) as never, OrderStatus.CONFIRMED, {
        isDeliveredDemotion: true,
      }),
    );
    expect(db.committed.order.status).toBe("CONFIRMED");
    expect(db.committed.order.deliveredAt).toBeNull(); // only deliveredAt is cleared
    const impact = await cancelImpact(
      {
        prisma: db.prisma,
        creditNotes: { previewOrderCreditRelease: async () => [] } as never,
      },
      "o1",
    );
    expect(impact.canCancel).toBe(false); // red on base: true (nothing was ever booked as delivered)
    expect(impact.deliveredUnits).toBe(10);
    expect(db.line("a").deliveredQty).toBe(10);
  });
});
