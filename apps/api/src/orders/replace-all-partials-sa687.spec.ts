/**
 * SA-687 M1 (found reviewing SA-681): the fall-through that bills "qty - invoicedQty" at Mark
 * Delivered trusts OrderItem.invoicedQty, but a REPLACE-ALL edit resets it. updateOrderItems
 * (replaceAll) does `orderItem.deleteMany` + recreate: the new lines carry the schema default
 * invoicedQty 0, and InvoiceItem.orderItemId is onDelete SetNull, so the partials keep billing
 * through ORPHANED invoice lines. Mark Delivered then billed the WHOLE order again: 6 + 4 + 10 boxes
 * on a 10-box order (610.54 on a 305.27 order).
 *
 * This drives the REAL OrdersService.updateOrderItems (replaceAll) and the REAL InvoicesService
 * writers; only the row effects of the replace-all's delete/create are wired into the stateful fake
 * (L-226: no hand-edited rows). Reached in production by the auto-merge into a PENDING order
 * (orders.controller create-merge, buyer cart merge), the buyer full-list edit and the staff
 * replaceAll.
 */
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { ConflictException, Logger } from "@nestjs/common";
import { createMockPrisma } from "../testing/prisma-mock";
import { settleOrderInvoice } from "./order-status-invoicing";
import { SplitInvoiceFakeDb, fakeOrderLine } from "../invoices/testing/split-invoice-fake-db";
import { buildSplitInvoicesService } from "../invoices/testing/split-invoice-service";

// The harness jest.mock()s invoices.service (a stub class); this spec needs the real one.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { InvoicesService: RealInvoicesService } = jest.requireActual("../invoices/invoices.service");

const ORDER_TOTAL = 305.27; // 10 boxes x 12 pieces, 282.00 + 23.27 tax

const sum = (rows: Array<{ total: unknown }>) =>
  Math.round(rows.reduce((s, i) => s + Number(i.total), 0) * 100) / 100;

/** A 10-box order split 6 / 4 by the real writers, then REPLACED (same lines) by the real updateOrderItems. */
async function splitThenReplaceAll(orderStatus: string) {
  const h = await buildOrdersService();
  const invPrisma = createMockPrisma();
  const db = new SplitInvoiceFakeDb();
  db.install(invPrisma);
  const real: any = await buildSplitInvoicesService(RealInvoicesService, invPrisma);

  db.addOrder(
    {
      id: "ord-1",
      customerId: "cust-1",
      orderNumber: "ORD-1",
      subtotal: 282,
      tax: 23.27,
      shippingFee: 0,
      total: ORDER_TOTAL,
    },
    [fakeOrderLine()],
  );
  await real.createPartialFromOrder("ord-1", { items: [{ orderItemId: "oi-1", qty: 72 }] });
  await real.createPartialFromOrder("ord-1", { items: [{ orderItemId: "oi-1", qty: 48 }] });
  expect(db.invoicesOf("ord-1")).toHaveLength(2);

  // the replace-all's row effects land in the fake; the order-side invoice sync stays the harness stub
  h.prisma.orderItem.deleteMany.mockImplementation(async (a: any) =>
    db.deleteOrderLines(a.where.orderId),
  );
  h.prisma.orderItem.create.mockImplementation(async (a: any) => db.createOrderLine(a.data));
  h.module
    .get(require("../invoices/invoices.service").InvoicesService)
    .reconcileOrderDraftInvoice.mockImplementation((...a: unknown[]) =>
      real.reconcileOrderDraftInvoice(...a),
    );
  h.prisma.product.findMany.mockResolvedValue([
    { id: "p-1", name: "Widget", unitsPerBox: 12, pricePerUnit: 2.35, trackedCategoryId: null },
  ]);
  h.prisma.order.findUnique.mockImplementation(async () => ({
    id: "ord-1",
    tenantId: "t1",
    customerId: "cust-1",
    status: orderStatus,
    routeRun: null,
    subtotal: 282,
    tax: 23.27,
    total: ORDER_TOTAL,
    lineItems: db.orderItems.map((l) => ({
      ...l,
      deliveredQty: 0,
      position: 0,
      overrideReason: null,
      overriddenBy: null,
    })),
  }));

  // the SAME lines, replaced (what a create-merge / buyer cart merge / staff replaceAll writes)
  await h.service.updateOrderItems(
    "ord-1",
    {
      replaceAll: true,
      items: [
        { productId: "p-1", qty: 120, boxes: 10, pieces: 0, unitsPerBox: 12, unitPrice: 28.2 },
      ],
    } as never,
    operatorPayload as never,
  );
  // the real path really did it: new line id, invoicedQty 0, the partials' lines orphaned
  expect(db.orderItems.map((l) => [l.id !== "oi-1", l.invoicedQty])).toEqual([[true, 0]]);
  expect(db.invoiceItems.every((it) => it.orderItemId === null)).toBe(true);
  expect(db.invoicesOf("ord-1")).toHaveLength(2);

  const settle = (moment: "delivered" | "shipped", alreadySettledAtShipment = false) =>
    settleOrderInvoice(
      { invoicesService: real, prisma: invPrisma } as never,
      "ord-1",
      { error: jest.fn() } as unknown as Logger,
      moment,
      alreadySettledAtShipment,
    );
  return { db, real, settle };
}

const expectReviewConflict = (out: unknown) => {
  expect(out).toBeInstanceOf(ConflictException);
  expect((out as ConflictException).getResponse()).toMatchObject({
    code: "ORDER_INVOICES_NEED_REVIEW",
    message:
      "This order's invoices don't match its lines. Review the invoices before billing more.",
  });
};

describe("SA-687 M1: a replace-all edit of an order with partial invoices, then Mark Delivered", () => {
  it("open drafts: bills nothing more and returns the review conflict (unguarded: a third invoice for the whole order)", async () => {
    const { db, settle } = await splitThenReplaceAll("PENDING");
    expectReviewConflict(await settle("delivered"));
    const after = db.invoicesOf("ord-1");
    expect(after).toHaveLength(2); // unguarded: 3 (6 + 4 + 10 boxes)
    expect(sum(after)).toBe(ORDER_TOTAL); // unguarded: 610.54
  });

  it("no open draft (PARTIALLY_DELIVERED, staff SENT the partials, then a manual Mark Delivered): the same refusal", async () => {
    const { db, settle } = await splitThenReplaceAll("PARTIALLY_DELIVERED");
    for (const inv of db.invoices) inv.status = "SENT";
    expectReviewConflict(await settle("delivered"));
    const after = db.invoicesOf("ord-1");
    expect(after).toHaveLength(2); // unguarded: 3
    expect(sum(after)).toBe(ORDER_TOTAL); // unguarded: 610.54
  });

  it("ship mode (billed at shipment): Delivered after Shipped, with no draft left, refuses too", async () => {
    const { db, settle } = await splitThenReplaceAll("OUT_FOR_DELIVERY");
    for (const inv of db.invoices) inv.status = "SENT";
    // settledAtShipment makes the open draft null on DELIVERED, so the guard must not live under `if (draft)`
    expectReviewConflict(await settle("delivered", true));
    expect(db.invoicesOf("ord-1")).toHaveLength(2); // unguarded: 3
  });

  it("S3: 'Split into invoice' for the full qty is refused as well (createPartialFromOrder has the same check)", async () => {
    const { db, real } = await splitThenReplaceAll("PENDING");
    const caught: unknown = await real
      .createPartialFromOrder("ord-1", {
        items: [{ orderItemId: db.orderItems[0].id, qty: 120 }],
      })
      .catch((e: unknown) => e);
    expectReviewConflict(caught);
    expect(db.invoicesOf("ord-1")).toHaveLength(2); // unguarded: 3, billed 610.54
  });
});
