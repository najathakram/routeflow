import { OrderStatus } from "@prisma/client";
import { makeStampDb } from "../common/testing/delivered-stamp-fake-db";
import { cancelImpact } from "./order-cancel-impact";
import { updateStatusWithShipMarker } from "./order-ship-state";
import { buildStatusUpdateData } from "./order-status-claim";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

// SHIP-order marker path: the revision write is not under test here, only that it is (not) reached.
const mockAppendRevision = jest.fn();
jest.mock("./order-revisions", () => ({
  ...jest.requireActual("./order-revisions"),
  appendOrderRevisionInTx: (...args: unknown[]) => mockAppendRevision(...args),
}));

/**
 * B692 (SA-814 R4-3), MUST rows (a)-(d), through the real status writer, cancel-impact and the cancel unwind.
 * Master wrote nothing for a manual PARTIALLY_DELIVERED: no deliveredQty, no evidence row. The order then read
 * "nothing delivered", so a cancel credited every unit and voided every invoice. The state-based cases use the
 * in-memory store that rolls back like a transaction.
 */
type Db = ReturnType<typeof makeStampDb>;
const header = (db: Db, fulfillPath = "ROUTE") => ({
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
type Delivery = { orderItemId: string; quantityDelivered: number; note?: string };
// the third argument is built loose: on master it has no `deliveries` member (the assertion, not the compiler, must fail)
const manualPd = (
  db: Db,
  from: OrderStatus,
  deliveries?: Delivery[],
  opts: { path?: string; featureConfig?: unknown } = {},
) => {
  const dto: Record<string, unknown> = { status: OrderStatus.PARTIALLY_DELIVERED };
  if (deliveries) dto.deliveries = deliveries;
  if (from === OrderStatus.DELIVERED) dto.reason = "wasn't all delivered";
  return updateStatusWithShipMarker(
    { prisma: db.prisma, featureConfig: opts.featureConfig as never },
    { ...header(db, opts.path), status: from },
    dto as never,
    undefined,
    buildStatusUpdateData(header(db, opts.path) as never, OrderStatus.PARTIALLY_DELIVERED, {
      isDeliveredDemotion: from === OrderStatus.DELIVERED,
    }),
  );
};
const impactOf = (db: Db) =>
  cancelImpact(
    { prisma: db.prisma, creditNotes: { previewOrderCreditRelease: async () => [] } as never },
    "o1",
  );
const THREE_LINES = [
  { id: "a", qty: 10, deliveredQty: 0 },
  { id: "b", qty: 4, deliveredQty: 0 },
];

describe("(a) a bare manual PARTIALLY_DELIVERED is refused and the status is unchanged", () => {
  it("OUT_FOR_DELIVERY, no quantities, no evidence: 409 ORDER_PD_NEEDS_QUANTITIES", async () => {
    const db = makeStampDb({ status: "OUT_FOR_DELIVERY", lines: THREE_LINES });
    await expect(manualPd(db, OrderStatus.OUT_FOR_DELIVERY)).rejects.toMatchObject({
      response: {
        code: "ORDER_PD_NEEDS_QUANTITIES",
        message: "Record what was delivered for each line first.",
      },
      status: 409,
    });
    expect(db.committed.order.status).toBe("OUT_FOR_DELIVERY"); // red on master: PARTIALLY_DELIVERED
    expect(db.committed.mutations).toHaveLength(0);
  });

  it("an empty deliveries[] or all-zero quantities is still bare (nothing was delivered)", async () => {
    const db = makeStampDb({ status: "OUT_FOR_DELIVERY", lines: THREE_LINES });
    await expect(manualPd(db, OrderStatus.OUT_FOR_DELIVERY, [])).rejects.toMatchObject({
      response: { code: "ORDER_PD_NEEDS_QUANTITIES" },
    });
    await expect(
      manualPd(db, OrderStatus.OUT_FOR_DELIVERY, [{ orderItemId: "a", quantityDelivered: 0 }]),
    ).rejects.toMatchObject({ response: { code: "ORDER_PD_NEEDS_QUANTITIES" } });
    expect(db.committed.order.status).toBe("OUT_FOR_DELIVERY");
    expect(db.committed.mutations).toHaveLength(0);
  });

  it("a legacy DELIVERED order (never stamped, no rows) demoted bare is refused too", async () => {
    const db = makeStampDb({ status: "DELIVERED", lines: THREE_LINES });
    await expect(manualPd(db, OrderStatus.DELIVERED)).rejects.toMatchObject({
      response: { code: "ORDER_PD_NEEDS_QUANTITIES" },
    });
    expect(db.committed.order.status).toBe("DELIVERED");
  });

  it("existing delivery data is the signal: a stamped line, or an evidence row, allows the bare flip", async () => {
    const stamped = makeStampDb({
      status: "DELIVERED",
      lines: [{ id: "a", qty: 10, deliveredQty: 10 }],
    });
    await manualPd(stamped, OrderStatus.DELIVERED);
    expect(stamped.committed.order.status).toBe("PARTIALLY_DELIVERED");

    const evidenced = makeStampDb({
      status: "OUT_FOR_DELIVERY",
      lines: [{ id: "a", qty: 10, deliveredQty: 0 }],
      mutations: [{ orderItemId: "a", type: "REFUSED", quantityDelivered: 0 }],
    });
    await manualPd(evidenced, OrderStatus.OUT_FOR_DELIVERY);
    expect(evidenced.committed.order.status).toBe("PARTIALLY_DELIVERED");
  });

  it("a carrier order that bills at shipment: the refusal comes BEFORE the reopen marker", async () => {
    mockAppendRevision.mockClear();
    const db = makeStampDb({ status: "DELIVERED", lines: THREE_LINES });
    const featureConfig = { getEffectiveMode: async () => "ship" };
    await expect(
      manualPd(db, OrderStatus.DELIVERED, undefined, { path: "SHIP", featureConfig }),
    ).rejects.toMatchObject({ response: { code: "ORDER_PD_NEEDS_QUANTITIES" } });
    expect(db.committed.order.status).toBe("DELIVERED");
    expect(mockAppendRevision).not.toHaveBeenCalled();
  });
});

describe("(b) deliveries[] are the quantities: stamped from evidence rows, then a cancel restocks only the rest", () => {
  const deliveries = [
    { orderItemId: "a", quantityDelivered: 6 },
    { orderItemId: "b", quantityDelivered: 4 },
  ];

  it("writes one evidence row per named line and recomputes deliveredQty from them", async () => {
    const db = makeStampDb({ status: "OUT_FOR_DELIVERY", lines: THREE_LINES });
    await manualPd(db, OrderStatus.OUT_FOR_DELIVERY, deliveries);
    expect(db.committed.order.status).toBe("PARTIALLY_DELIVERED");
    expect(db.line("a").deliveredQty).toBe(6); // red on master: 0
    expect(db.line("b").deliveredQty).toBe(4); // red on master: 0
    expect(db.committed.mutations).toEqual([
      expect.objectContaining({ orderItemId: "a", type: "PARTIAL", quantityDelivered: 6 }),
      expect.objectContaining({ orderItemId: "b", type: "DELIVERED", quantityDelivered: 4 }),
    ]);
  });

  it("a quantity above what is left, a duplicate line and a foreign line are refused with nothing written", async () => {
    const run = (d: Delivery[]) =>
      manualPd(
        makeStampDb({ status: "OUT_FOR_DELIVERY", lines: THREE_LINES }),
        OrderStatus.OUT_FOR_DELIVERY,
        d,
      );
    await expect(run([{ orderItemId: "a", quantityDelivered: 11 }])).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      run([
        { orderItemId: "a", quantityDelivered: 1 },
        { orderItemId: "a", quantityDelivered: 1 },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(run([{ orderItemId: "zzz", quantityDelivered: 1 }])).rejects.toMatchObject({
      status: 404,
    });
    const db = makeStampDb({ status: "OUT_FOR_DELIVERY", lines: THREE_LINES });
    await expect(
      manualPd(db, OrderStatus.OUT_FOR_DELIVERY, [
        { orderItemId: "b", quantityDelivered: 3 },
        { orderItemId: "a", quantityDelivered: 99 },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.committed.order.status).toBe("OUT_FOR_DELIVERY"); // the first row rolled back with it
    expect(db.committed.mutations).toHaveLength(0);
    expect(db.line("b").deliveredQty).toBe(0);
  });

  it("a second record on the same line is bounded by what its first rows already delivered", async () => {
    const db = makeStampDb({ status: "OUT_FOR_DELIVERY", lines: THREE_LINES });
    await manualPd(db, OrderStatus.OUT_FOR_DELIVERY, [{ orderItemId: "a", quantityDelivered: 6 }]);
    const again = (q: number) =>
      manualPd(db, OrderStatus.PARTIALLY_DELIVERED, [{ orderItemId: "a", quantityDelivered: q }]);
    await expect(again(5)).rejects.toMatchObject({ status: 400 }); // 6 + 5 > 10
    await again(4);
    expect(db.line("a").deliveredQty).toBe(10);
  });

  it("a carrier order that bills at shipment: evidence and the reopen marker commit together", async () => {
    mockAppendRevision.mockClear();
    const db = makeStampDb({ status: "DELIVERED", lines: THREE_LINES });
    const featureConfig = { getEffectiveMode: async () => "ship" };
    await manualPd(db, OrderStatus.DELIVERED, [{ orderItemId: "b", quantityDelivered: 4 }], {
      path: "SHIP",
      featureConfig,
    });
    expect(db.committed.order.status).toBe("PARTIALLY_DELIVERED");
    expect(db.line("b").deliveredQty).toBe(4);
    expect(mockAppendRevision).toHaveBeenCalledTimes(1);
    expect(mockAppendRevision.mock.calls[0]).toContain("REOPENED_FROM_DELIVERY");
  });

  it("the cancel is refused on the delivered part (invoices are not voided)", async () => {
    const db = makeStampDb({ status: "OUT_FOR_DELIVERY", lines: THREE_LINES });
    await manualPd(db, OrderStatus.OUT_FOR_DELIVERY, deliveries);
    const impact = await impactOf(db);
    expect(impact.deliveredUnits).toBe(10); // red on master: 0
    expect(impact.canCancel).toBe(false); // red on master: true
    expect(impact.deliveryQuantitiesMissing).toBe(false);
  });

  it("and the stock unwind restocks only the undelivered remainder", async () => {
    const db = makeStampDb({ status: "OUT_FOR_DELIVERY", lines: THREE_LINES });
    await manualPd(db, OrderStatus.OUT_FOR_DELIVERY, [{ orderItemId: "a", quantityDelivered: 6 }]);
    const h = await buildOrdersService();
    const { prisma } = h;
    prisma.order.findUnique.mockResolvedValue({ id: "o1", status: "PARTIALLY_DELIVERED" });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.orderItem.findMany.mockResolvedValue([
      {
        id: "a",
        productId: "prod-1",
        qty: 10,
        deliveredQty: db.line("a").deliveredQty,
        status: "PENDING",
        unitsPerBox: null,
        boxes: null,
        pieces: null,
        unitLabel: null,
      },
    ] as never);
    prisma.product.findMany.mockResolvedValue([
      { id: "prod-1", name: "Tomatoes", currentStock: 50, unitsPerBox: null },
    ] as never);
    prisma.product.update.mockResolvedValue({ id: "prod-1", currentStock: 54 } as never);
    await prisma.tenantTransaction((tx: any) =>
      h.service.cancelOrderInTx(tx, { id: "o1" }, {
        fromStatuses: ["PARTIALLY_DELIVERED"],
        statusUpdateData: { status: "CANCELLED" },
        carrier: null,
        user: { sub: "u", role: "OPERATOR", tenantId: "t" },
        notes: "CANCEL",
      } as never),
    );
    const credits = prisma.product.update.mock.calls.map(
      (c) => (c[0] as any).data.currentStock.increment,
    );
    expect(credits).toEqual([4]); // red on master: [10] (the stamp never happened)
  });
});

describe("(c) a legacy delivered order with no quantity signal refuses the cancel", () => {
  it.each(["PARTIALLY_DELIVERED", "DELIVERED"])(
    "cancel-impact on a %s order whose lines all read 0 and has no evidence",
    async (status) => {
      const db = makeStampDb({ status, lines: THREE_LINES });
      const impact = await impactOf(db);
      expect(impact.deliveryQuantitiesMissing).toBe(true); // red on master: undefined
      expect(impact.canCancel).toBe(false); // red on master: true
    },
  );

  it("changeStatus -> CANCELLED answers 409 ORDER_DELIVERY_QUANTITIES_MISSING before any write", async () => {
    const h = await buildOrdersService();
    const { prisma } = h;
    prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-1",
      status: "PARTIALLY_DELIVERED",
      fulfillPath: "ROUTE",
      routeRunStopId: null,
      subtotal: 10,
      tax: 0,
      total: 10,
      deliveredAt: null,
      orderDate: null,
      notes: null,
    });
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-1",
      status: "PARTIALLY_DELIVERED",
      orderNumber: "ORD-1",
    });
    prisma.invoice.findMany.mockResolvedValue([
      { id: "inv-1", invoiceNumber: "INV-1", status: "SENT", total: 10, payments: [] },
    ]);
    prisma.orderItem.findMany.mockResolvedValue([
      { id: "li-1", productId: "p1", qty: 10, deliveredQty: 0, status: "PENDING" },
    ]);
    prisma.deliveryMutation.findMany.mockResolvedValue([]);
    await expect(
      h.service.changeStatus("ord-1", { status: "CANCELLED" } as never, operatorPayload as never),
    ).rejects.toMatchObject({
      response: {
        code: "ORDER_DELIVERY_QUANTITIES_MISSING",
        message: "Delivery quantities are missing; set them before cancelling.",
      },
      status: 409,
    });
    expect(prisma.product.update).not.toHaveBeenCalled(); // red on master: stock credited in full
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("any delivery signal lifts the refusal: a stamped line, or an evidence row, or no active lines", async () => {
    const stamped = makeStampDb({
      status: "PARTIALLY_DELIVERED",
      lines: [{ id: "a", qty: 10, deliveredQty: 3 }],
    });
    expect((await impactOf(stamped)).deliveryQuantitiesMissing).toBe(false);
    const evidenced = makeStampDb({
      status: "PARTIALLY_DELIVERED",
      lines: THREE_LINES,
      mutations: [{ orderItemId: "a", type: "PARTIAL", quantityDelivered: 2 }],
    });
    expect((await impactOf(evidenced)).deliveryQuantitiesMissing).toBe(false);
    const noLines = makeStampDb({ status: "DELIVERED", lines: [] });
    expect((await impactOf(noLines)).deliveryQuantitiesMissing).toBe(false);
  });

  it("an order that has not shipped keeps its cancel: the flag reads nothing, no evidence query", async () => {
    const db = makeStampDb({ status: "CONFIRMED", lines: THREE_LINES });
    const spy = jest.spyOn(db.prisma.forTenant().deliveryMutation, "findMany");
    const impact = await impactOf(db);
    expect(impact.deliveryQuantitiesMissing).toBe(false);
    expect(impact.canCancel).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("(d) control: the DELIVERED path is unchanged", () => {
  it("a manual DELIVERED still stamps every no-evidence line to its qty and writes no evidence row", async () => {
    const db = makeStampDb({ status: "CONFIRMED", lines: THREE_LINES });
    await updateStatusWithShipMarker(
      { prisma: db.prisma },
      { ...header(db), status: OrderStatus.CONFIRMED },
      { status: OrderStatus.DELIVERED },
      undefined,
      buildStatusUpdateData(header(db) as never, OrderStatus.DELIVERED, {
        isDeliveredDemotion: false,
      }),
    );
    expect(db.committed.order.status).toBe("DELIVERED");
    expect(db.line("a").deliveredQty).toBe(10);
    expect(db.line("b").deliveredQty).toBe(4);
    expect(db.committed.mutations).toHaveLength(0);
  });

  it("a non-delivery status write (CONFIRMED -> OUT_FOR_DELIVERY) needs no quantities and opens no transaction", async () => {
    const db = makeStampDb({ status: "CONFIRMED", lines: THREE_LINES });
    await updateStatusWithShipMarker(
      { prisma: db.prisma },
      { ...header(db), status: OrderStatus.CONFIRMED },
      { status: OrderStatus.OUT_FOR_DELIVERY },
      undefined,
      buildStatusUpdateData(header(db) as never, OrderStatus.OUT_FOR_DELIVERY, {
        isDeliveredDemotion: false,
      }),
    );
    expect(db.committed.order.status).toBe("OUT_FOR_DELIVERY");
    expect(db.calls.txCount).toBe(0);
  });
});
