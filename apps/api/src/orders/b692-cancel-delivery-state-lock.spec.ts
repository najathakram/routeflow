// The harness FIRST: it jest.mock()s modules that orders.service also imports.
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { OrderStatus } from "@prisma/client";
import { cancelImpact } from "./order-cancel-impact";
import {
  assertCancelDeliveryStateUnderLock,
  cancelOrderInTx,
  lockDeleteLines,
} from "./order-cancel-tx";

// The cash-refund guard has its own specs; it is not under test here.
jest.mock("../invoices/invoice-cash-refund-guard", () => ({
  assertNoCashRefundOnOrder: jest.fn().mockResolvedValue(undefined),
}));

/**
 * SA-814h (B692): the cancel's delivery-state refusals are decided from lines/evidence read UNDER the Order lock;
 * the pre-checks (cancelImpact / assertCancellableOrThrow) are advisory. A hard delete refuses a legacy delivered
 * row the same way. DELIVERED -> CONFIRMED (with its reason) stays allowed.
 */
type Line = { id?: string; deliveredQty: number; qty?: number; status?: string };

/** A tx whose reads answer from the given rows; every write is a jest.fn so a test can assert none ran. */
function makeTx(opts: { status: string; lines: Line[]; mutations?: unknown[] }) {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
    order: {
      findUnique: jest.fn().mockResolvedValue({ id: "o1", status: opts.status }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    orderItem: {
      findMany: jest.fn().mockResolvedValue(opts.lines),
      updateMany: jest.fn(),
    },
    deliveryMutation: { findMany: jest.fn().mockResolvedValue(opts.mutations ?? []) },
    invoice: { findMany: jest.fn().mockResolvedValue([{ id: "inv-1" }]) },
    invoiceItem: { findMany: jest.fn().mockResolvedValue([]) },
  };
}
const deps = () => ({
  settleStockForEdit: jest.fn(),
  creditNotes: { releaseOrderCreditsInTx: jest.fn() },
  invoices: { releaseWalletPaymentsInTx: jest.fn(), voidInvoiceInTx: jest.fn() },
});
const cancelOpts = (extra: Record<string, unknown> = {}) =>
  ({
    fromStatuses: [OrderStatus.PARTIALLY_DELIVERED, OrderStatus.CONFIRMED],
    statusUpdateData: { status: OrderStatus.CANCELLED },
    carrier: null,
    user: operatorPayload,
    notes: "CANCEL",
    ...extra,
  }) as never;
const run = (d: ReturnType<typeof deps>, tx: ReturnType<typeof makeTx>, extra = {}) =>
  cancelOrderInTx(d as never, tx, { id: "o1" }, cancelOpts(extra));

describe("(f) the cancel re-reads the delivery state under the lock", () => {
  it("a route stop delivered between the pre-check and the lock: 409, no restock, no invoice void", async () => {
    // pre-check (before the lock): the order is CONFIRMED with nothing delivered, so it looks cancellable
    const pre = await cancelImpact(
      {
        prisma: {
          forTenant: () => ({
            order: { findFirst: async () => ({ id: "o1", status: "CONFIRMED", orderNumber: "1" }) },
            invoice: { findMany: async () => [] },
            orderItem: { findMany: async () => [{ qty: 10, deliveredQty: 0 }] },
            deliveryMutation: { findMany: async () => [] },
          }),
        } as never,
        creditNotes: { previewOrderCreditRelease: async () => [] } as never,
      },
      "o1",
    );
    expect(pre.canCancel).toBe(true);

    // under the lock: the stop completed, the order is PARTIALLY_DELIVERED and a line reads 6 delivered
    const tx = makeTx({ status: "PARTIALLY_DELIVERED", lines: [{ qty: 10, deliveredQty: 6 }] });
    const d = deps();
    await expect(run(d, tx)).rejects.toMatchObject({
      status: 409,
      response: { code: "ORDER_CHANGED_DURING_EDIT" },
    });
    expect(tx.order.updateMany).not.toHaveBeenCalled(); // the claim never ran
    expect(d.settleStockForEdit).not.toHaveBeenCalled(); // no restock
    expect(d.invoices.voidInvoiceInTx).not.toHaveBeenCalled(); // no void
    expect(d.creditNotes.releaseOrderCreditsInTx).not.toHaveBeenCalled();
    expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
  });

  it("a legacy PD row (all lines 0, no evidence) under the lock: 409 ORDER_DELIVERY_QUANTITIES_MISSING", async () => {
    const tx = makeTx({ status: "PARTIALLY_DELIVERED", lines: [{ qty: 10, deliveredQty: 0 }] });
    const d = deps();
    await expect(run(d, tx)).rejects.toMatchObject({
      status: 409,
      response: { code: "ORDER_DELIVERY_QUANTITIES_MISSING" },
    });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(d.settleStockForEdit).not.toHaveBeenCalled();
    expect(d.invoices.voidInvoiceInTx).not.toHaveBeenCalled();
  });

  it("an undelivered order cancels as before", async () => {
    const tx = makeTx({ status: "CONFIRMED", lines: [{ qty: 10, deliveredQty: 0 }] });
    const d = deps();
    await run(d, tx);
    expect(tx.order.updateMany).toHaveBeenCalled();
    expect(d.invoices.voidInvoiceInTx).toHaveBeenCalled();
  });

  it("the counter-sale void opts out: its delivered lines do not refuse", async () => {
    const tx = makeTx({ status: "DELIVERED", lines: [{ qty: 10, deliveredQty: 10 }] });
    await run(deps(), tx, { fromStatuses: [OrderStatus.DELIVERED], skipDeliveryStateCheck: true });
    expect(tx.order.updateMany).toHaveBeenCalled();
  });

  it("the helper alone: delivered units refuse; refuseDeliveredUnits:false reads only the legacy predicate", async () => {
    const tx = makeTx({ status: "PARTIALLY_DELIVERED", lines: [{ deliveredQty: 2 }] });
    await expect(assertCancelDeliveryStateUnderLock(tx, { id: "o1" })).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      assertCancelDeliveryStateUnderLock(tx, { id: "o1" }, { refuseDeliveredUnits: false }),
    ).resolves.toBeUndefined();
  });
});

describe("(g) a hard delete refuses a legacy delivered row under the lock", () => {
  it.each(["DELIVERED", "PARTIALLY_DELIVERED"])(
    "%s with all lines 0 and no evidence: 409, before any line is returned for restock",
    async (status) => {
      const tx = makeTx({ status, lines: [{ qty: 10, deliveredQty: 0 }] });
      await expect(lockDeleteLines(tx, "o1")).rejects.toMatchObject({
        status: 409,
        response: {
          code: "ORDER_DELIVERY_QUANTITIES_MISSING",
          message: "Delivery quantities are missing; set them before deleting.",
        },
      });
    },
  );

  it("any delivery signal, or an order that has not shipped, deletes as before", async () => {
    const stamped = makeTx({
      status: "PARTIALLY_DELIVERED",
      lines: [{ qty: 10, deliveredQty: 3 }],
    });
    const held = await lockDeleteLines(stamped, "o1");
    expect(held?.order).toEqual({ id: "o1", status: "PARTIALLY_DELIVERED" });
    const confirmed = makeTx({ status: "CONFIRMED", lines: [{ qty: 10, deliveredQty: 0 }] });
    expect(await lockDeleteLines(confirmed, "o1")).not.toBeNull();
    expect(confirmed.deliveryMutation.findMany).not.toHaveBeenCalled(); // no extra evidence query
  });

  it("deleteOrder answers 409 and writes nothing", async () => {
    const h = await buildOrdersService();
    const { prisma } = h;
    prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      status: "DELIVERED",
      customerId: "c1",
      fulfillPath: "ROUTE",
      invoices: [{ id: "inv-1" }],
      transaction: null,
    });
    prisma.return.count.mockResolvedValue(0);
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-1",
      status: "DELIVERED",
      orderNumber: "1",
    });
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.orderItem.findMany.mockResolvedValue([{ id: "li-1", qty: 10, deliveredQty: 0 }]);
    prisma.deliveryMutation.findMany.mockResolvedValue([]);
    await expect(h.service.deleteOrder("ord-1", operatorPayload as never)).rejects.toMatchObject({
      status: 409,
      response: { code: "ORDER_DELIVERY_QUANTITIES_MISSING" },
    });
    expect(prisma.order.delete).not.toHaveBeenCalled();
    expect(prisma.invoice.delete).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
  });
});

describe("(h) DELIVERED -> CONFIRMED stays allowed and its reason is recorded (SA-814h)", () => {
  it("a legacy delivered order reopens with its reason appended to the order's status history", async () => {
    const h = await buildOrdersService();
    const { prisma } = h;
    const delivered = {
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-1",
      status: "DELIVERED",
      fulfillPath: "ROUTE",
      routeRunStopId: null,
      subtotal: 10,
      tax: 0,
      total: 10,
      deliveredAt: new Date(),
      orderDate: null,
      notes: "earlier note",
    };
    prisma.order.findUnique.mockResolvedValue(delivered);
    prisma.orderItem.findMany.mockResolvedValue([{ id: "li-1", qty: 10, deliveredQty: 0 }]); // legacy: no quantity
    prisma.deliveryMutation.findMany.mockResolvedValue([]);
    prisma.order.update.mockResolvedValue({ ...delivered, status: "CONFIRMED" });

    await h.service.changeStatus(
      "ord-1",
      { status: "CONFIRMED", reason: "customer refused the pallet" } as never,
      operatorPayload as never,
    );

    const data = prisma.order.update.mock.calls[0][0].data;
    expect(data.status).toBe("CONFIRMED");
    expect(data.deliveredAt).toBeNull();
    expect(data.notes).toContain("earlier note");
    expect(data.notes).toContain("status changed to CONFIRMED: customer refused the pallet");
  });
});
