/**
 * SA-763r P-3 (M4 + M5, red rows 8 and 9): an order edit never creates an overpayment. The judge runs at the
 * tail of the edit tx, after the Order row, and locks the order's invoices FOR UPDATE (id-sorted) before it
 * reads payments. It projects each invoice's post-edit total with the re-sync's own builder (plan mode), counts
 * EXTERNAL held payments only (PAID + in-flight DRAFT / PENDING; never CREDIT_NOTE / ADVANCE / VOID) and
 * refuses with 409 ORDER_EDIT_WOULD_OVERPAY {invoiceId, paid, projectedTotal, excess}, writing nothing.
 *
 * Fixtures are built with the real writer over the stateful fake in invoices/testing/split-invoice-fake-db.ts.
 */

jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { ConflictException } from "@nestjs/common";
import { InvoicesService } from "../invoices/invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SplitInvoiceFakeDb, fakeOrderLine } from "../invoices/testing/split-invoice-fake-db";
import { buildSplitInvoicesService } from "../invoices/testing/split-invoice-service";
import { assertEditCannotOverpay, judgeEditTail } from "./edit-overpay-judge";

describe("assertEditCannotOverpay", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: SplitInvoiceFakeDb;
  let sql: string[];
  let payments: Array<{ invoiceId: string; amount: number; method: string; status: string }>;
  let tx: any;
  const mockLedger = {
    writeSaleEntries: jest.fn(),
    reverseInvoiceEntries: jest.fn(),
    syncInvoiceEntries: jest.fn(),
  };

  beforeEach(async () => {
    sql = [];
    payments = [];
    prisma = createMockPrisma();
    db = new SplitInvoiceFakeDb();
    db.install(prisma);
    service = await buildSplitInvoicesService(InvoicesService, prisma, mockLedger);
    const p = prisma as any;
    // The payment read honours the WHERE the judge sends (method notIn, status in), like Postgres would.
    p.invoicePayment.findMany.mockImplementation(async (args: any) =>
      payments.filter(
        (x) =>
          args.where.invoiceId.in.includes(x.invoiceId) &&
          !(args.where.method?.notIn ?? []).includes(x.method) &&
          (args.where.status?.in ?? [x.status]).includes(x.status),
      ),
    );
    tx = {
      ...p.forTenant(),
      invoicePayment: p.invoicePayment,
      $executeRaw: jest.fn((strings: TemplateStringsArray) => {
        const q = strings.join("?").replace(/\s+/g, " ");
        sql.push(
          /FROM "Order"/.test(q) ? "lock:Order" : /FROM "Invoice"/.test(q) ? "lock:Invoices" : q,
        );
        return Promise.resolve(0);
      }),
    };
  });

  const judge = (scope = { resync: true, partials: false }) =>
    assertEditCannotOverpay({ invoices: service, tenantId: "test-tenant" }, tx, "ord-1", scope);

  /** A DELIVERED order: 90 of goods + a 10 invoice shipping fee = 100, one invoice, nothing taxed. */
  const seedDelivered = (status = "SENT") => {
    db.addOrder(
      {
        id: "ord-1",
        customerId: "cust-1",
        orderNumber: "ORD-1",
        subtotal: 90,
        tax: 0,
        shippingFee: 10,
        total: 100,
        status: "DELIVERED",
      },
      [
        fakeOrderLine({
          qty: 90,
          boxes: null,
          pieces: null,
          unitsPerBox: null,
          unitPrice: 1,
          subtotal: 90,
          invoicedQty: 90,
          product: { name: "Widget", unitsPerBox: null },
        }),
      ],
    );
    db.invoices.push({
      id: "inv-1",
      orderId: "ord-1",
      customerId: "cust-1",
      tenantId: "test-tenant",
      invoiceNumber: "INV-1",
      status,
      deliveryBatchId: null,
      depositPercent: null,
      discount: 0,
      shippingFee: 10,
      dueDate: null,
      subtotal: 90,
      taxAmount: 0,
      total: 100,
      payments: [],
      createdAt: new Date(Date.UTC(2026, 0, 1)),
    });
    db.invoiceItems.push({
      id: "ii-1",
      invoiceId: "inv-1",
      orderItemId: "oi-1",
      productId: "p-1",
      qty: 90,
      subtotal: 90,
    });
  };
  /** The edit has written the order: the line is cut by 30 (the in-tx order row the judge reads). */
  const cutThirty = () => {
    Object.assign(db.line("oi-1"), { qty: 60, subtotal: 60 });
    Object.assign(db.orders.get("ord-1")!, { subtotal: 60, total: 70 });
  };
  const cash = (amount: number, over: Record<string, unknown> = {}) => ({
    invoiceId: "inv-1",
    amount,
    method: "CASH",
    status: "PAID",
    ...over,
  });

  it("paid 100, cut 30, invoice shipping fee 10: 409 with the exact body, nothing written", async () => {
    seedDelivered();
    cutThirty();
    payments.push(cash(100));
    const err: any = await judge().catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: "ORDER_EDIT_WOULD_OVERPAY",
      invoiceId: "inv-1",
      paid: 100,
      projectedTotal: 70, // 60 of goods + the invoice's own 10 shipping fee (not the order's 60)
      excess: 30,
    });
    expect(db.invoiceUpdateCalls).toHaveLength(0); // plan mode: the judge never writes
    expect((prisma as any).auditLog.create).not.toHaveBeenCalled();
    expect(db.invoices[0].total).toBe(100);
  });

  it("locks the Order, then the order's invoices, before it reads a payment", async () => {
    seedDelivered();
    cutThirty();
    payments.push(cash(100));
    await judge().catch(() => undefined);
    expect(sql.slice(0, 2)).toEqual(["lock:Order", "lock:Invoices"]);
    expect((prisma as any).invoicePayment.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      (tx.$executeRaw as jest.Mock).mock.invocationCallOrder[1],
    );
  });

  it("a credit-note application (and an ADVANCE) is not external money: 200", async () => {
    seedDelivered();
    cutThirty();
    payments.push(cash(100, { method: "CREDIT_NOTE" }), cash(100, { method: "ADVANCE" }));
    await expect(judge()).resolves.toBeUndefined();
  });

  it("a VOID payment does not count; an in-flight PENDING check does (it may still clear)", async () => {
    seedDelivered();
    cutThirty();
    payments.push(cash(100, { status: "VOID" }));
    await expect(judge()).resolves.toBeUndefined();
    payments.push(cash(100, { method: "CHECK", status: "PENDING" }));
    await expect(judge()).rejects.toMatchObject({
      response: expect.objectContaining({ code: "ORDER_EDIT_WOULD_OVERPAY", excess: 30 }),
    });
  });

  it("paid 50 of 100 and a 20 cut: 200 (still owes); an increase is always allowed", async () => {
    seedDelivered();
    cutThirty();
    payments.push(cash(50));
    await expect(judge()).resolves.toBeUndefined();
    // an increase after final: the line grows, the projection is above what was paid
    payments.length = 0;
    payments.push(cash(100));
    Object.assign(db.line("oi-1"), { qty: 120, subtotal: 120 });
    Object.assign(db.orders.get("ord-1")!, { subtotal: 120, total: 130 });
    await expect(judge()).resolves.toBeUndefined();
  });

  it("nothing is restated (skipInPlaceResync, no partials): no lock, no projection, no payment read", async () => {
    seedDelivered();
    cutThirty();
    payments.push(cash(100));
    await expect(judge({ resync: false, partials: false })).resolves.toBeUndefined();
    expect(sql).toEqual([]);
    expect((prisma as any).invoicePayment.findMany).not.toHaveBeenCalled();
  });

  it("paid exactly the projected total is fine; one cent over is an overpayment", async () => {
    seedDelivered();
    cutThirty();
    payments.push(cash(70));
    await expect(judge()).resolves.toBeUndefined();
    payments[0].amount = 70.01; // a cent over
    await expect(judge()).rejects.toBeInstanceOf(ConflictException);
  });
  it("an UNCLEAN partition (a freeform line) on a post-delivery staff edit: the DRAFT partial that will follow the price cut is still judged (409)", async () => {
    // The re-sync bails on the freeform line (loadResyncInputs -> null), so the writer falls back to the
    // DRAFT-partial price follow. The judge must project exactly what the writer will do.
    db.addOrder(
      {
        id: "ord-1",
        customerId: "cust-1",
        orderNumber: "ORD-1",
        subtotal: 282,
        tax: 0,
        shippingFee: 0,
        total: 282,
        status: "DELIVERED",
      },
      [fakeOrderLine({ invoicedQty: 120 })], // wholly invoiced by the counter: the re-sync is not skipped
    );
    db.invoices.push({
      id: "inv-1",
      orderId: "ord-1",
      customerId: "cust-1",
      tenantId: "test-tenant",
      invoiceNumber: "INV-1",
      status: "DRAFT",
      deliveryBatchId: null,
      depositPercent: null,
      discount: 0,
      shippingFee: 0,
      dueDate: null,
      subtotal: 179.2,
      taxAmount: 0,
      total: 179.2,
      payments: [],
      createdAt: new Date(Date.UTC(2026, 0, 1)),
    });
    db.invoiceItems.push(
      {
        id: "ii-1",
        invoiceId: "inv-1",
        orderItemId: "oi-1",
        productId: "p-1",
        qty: 72,
        unitsPerBox: 12,
        unitPrice: 2.35,
        subtotal: 169.2,
      },
      {
        id: "ii-2",
        invoiceId: "inv-1",
        orderItemId: null,
        productId: null,
        description: "Freight",
        qty: 1,
        subtotal: 10,
      },
    );
    Object.assign(db.line("oi-1"), { unitPrice: 2, subtotal: 240 }); // the staff price cut
    Object.assign(db.orders.get("ord-1")!, { subtotal: 240, total: 240 });
    payments.push(cash(179.2)); // the delivery cash sits on the DRAFT partial

    const err: any = await judgeEditTail(
      { invoices: service, tenantId: "test-tenant" },
      tx,
      "ord-1",
      { heldItems: db.orderItems, postDeliveryEdit: true, role: "OPERATOR" },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "ORDER_EDIT_WOULD_OVERPAY",
      invoiceId: "inv-1",
      paid: 179.2,
      projectedTotal: 154, // 72/120 of 240 = 144, plus the freeform 10
      excess: 25.2,
    });
    expect(db.invoiceUpdateCalls).toHaveLength(0);
  });
});
