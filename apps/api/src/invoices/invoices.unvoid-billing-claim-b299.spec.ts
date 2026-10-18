/**
 * B299 / SA-814 R4-5: unvoiding an invoice RE-CLAIMS its qty on the order lines (invoicedQty +delta). The
 * claim was clamped at the line qty (`Math.min(qty, ...)`), so after "void A, bill B for the same goods,
 * unvoid A" the clamp hid the overlap: A and B were both live for the same goods. Under the SA-760 R-1
 * locks `unvoidInvoice` now refuses with 409 ORDER_BILLING_CHANGED, writing nothing, unless every line of A
 * still has `qty - invoicedQty >= delta` on a non-CANCELLED order line. The void direction (-1) keeps its clamp.
 *
 * Stateful fake (./testing/split-invoice-fake-db.ts), like invoices.order-billing-lock-sa760.spec.ts. The
 * real-Postgres row is ./b299-unvoid-billing-claim.db.spec.ts.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { InvoicesService } from "./invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SplitInvoiceFakeDb, fakeOrderLine } from "./testing/split-invoice-fake-db";
import { buildSplitInvoicesService } from "./testing/split-invoice-service";

describe("B299: unvoid re-claims invoicedQty only when the quantity is still free", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: SplitInvoiceFakeDb;
  const mockLedger = { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() };

  beforeEach(async () => {
    prisma = createMockPrisma();
    db = new SplitInvoiceFakeDb();
    db.install(prisma);
    const p = prisma as any;
    const raw = jest.fn().mockResolvedValue(0);
    p.$executeRaw = raw;
    p.tenantTransaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ ...p.forTenant(), $executeRaw: raw, $queryRaw: jest.fn() }),
    );
    // The pre-tx read and the locked re-read both see A as VOID.
    p.invoice.findUnique.mockImplementation(async () => ({
      id: "inv-a",
      orderId: "ord-1",
      status: db.invoices.find((i) => i.id === "inv-a")!.status,
      payments: [],
    }));
    service = await buildSplitInvoicesService(InvoicesService, prisma, mockLedger);
  });

  const seedVoidA = (
    lineOver: Record<string, unknown> = {},
    aItem: Record<string, unknown> = {},
  ) => {
    db.addOrder({ id: "ord-1", customerId: "cust-1", orderNumber: "ORD-1", total: 100 }, [
      fakeOrderLine({ id: "oi-1", qty: 120, invoicedQty: 0, ...lineOver }),
    ]);
    db.invoices.push({
      id: "inv-a",
      orderId: "ord-1",
      customerId: "cust-1",
      tenantId: "test-tenant",
      invoiceNumber: "INV-A",
      status: "VOID",
      createdAt: new Date(Date.UTC(2026, 0, 1)),
    });
    db.invoiceItems.push({
      id: "ii-a",
      invoiceId: "inv-a",
      orderItemId: "oi-1",
      productId: "p-1",
      qty: 60,
      ...aItem,
    });
  };
  /** B: a live invoice that bills `qty` of the same line (and so holds that much of invoicedQty). */
  const billB = (qty: number) => {
    db.invoices.push({
      id: "inv-b",
      orderId: "ord-1",
      customerId: "cust-1",
      tenantId: "test-tenant",
      invoiceNumber: "INV-B",
      status: "DRAFT",
      createdAt: new Date(Date.UTC(2026, 0, 2)),
    });
    db.invoiceItems.push({
      id: "ii-b",
      invoiceId: "inv-b",
      orderItemId: "oi-1",
      productId: "p-1",
      qty,
    });
    db.line("oi-1").invoicedQty = qty;
  };
  const statusOfA = () => db.invoices.find((i) => i.id === "inv-a")!.status;

  const expectRefused = async () => {
    await expect(service.unvoidInvoice("inv-a")).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: "ORDER_BILLING_CHANGED",
        message: "Another invoice now bills these items. Void it first.",
      }),
    });
    expect(statusOfA()).toBe("VOID"); // no write: A is still void
    expect(db.invoiceUpdateCalls).toHaveLength(0);
  };

  it("(a) void A, bill B for the same lines, unvoid A -> 409, A stays VOID, invoicedQty unchanged", async () => {
    seedVoidA();
    billB(120);
    await expectRefused();
    expect(db.line("oi-1").invoicedQty).toBe(120);
  });

  it("(a) a partial overlap is refused too (free 20 < 60), not clamped to the line qty", async () => {
    seedVoidA();
    billB(100);
    await expectRefused();
    expect(db.line("oi-1").invoicedQty).toBe(100);
  });

  it("(a) the refusal is all-or-nothing: a later line that is not free leaves the earlier one unclaimed", async () => {
    seedVoidA();
    db.orderItems.push(fakeOrderLine({ id: "oi-2", productId: "p-2", orderId: "ord-1", qty: 10 }));
    db.invoiceItems.push({
      id: "ii-a2",
      invoiceId: "inv-a",
      orderItemId: "oi-2",
      productId: "p-2",
      qty: 10,
    });
    db.line("oi-2").invoicedQty = 10; // oi-1 is free, oi-2 is billed elsewhere
    await expectRefused();
    expect(db.line("oi-1").invoicedQty).toBe(0);
    expect(db.line("oi-2").invoicedQty).toBe(10);
  });

  it("(b) control: the quantity is free -> unvoids to DRAFT and re-claims the qty", async () => {
    seedVoidA();
    await service.unvoidInvoice("inv-a");
    expect(statusOfA()).toBe("DRAFT");
    expect(db.line("oi-1").invoicedQty).toBe(60);
  });

  it("(b) control: exactly the remaining quantity is free -> succeeds (boundary, no off-by-one)", async () => {
    seedVoidA();
    billB(60); // free = 120 - 60 = 60 = A's qty
    await service.unvoidInvoice("inv-a");
    expect(statusOfA()).toBe("DRAFT");
    expect(db.line("oi-1").invoicedQty).toBe(120);
  });

  it("(c) a CANCELLED target order line is refused although its qty looks free", async () => {
    seedVoidA({ status: "CANCELLED" });
    await expectRefused();
    expect(db.line("oi-1").invoicedQty).toBe(0);
  });

  it("(c) a legacy invoice line (no orderItemId) whose only product line is CANCELLED is refused", async () => {
    seedVoidA({ status: "CANCELLED" }, { orderItemId: null });
    await expectRefused();
    expect(db.line("oi-1").invoicedQty).toBe(0);
  });

  it("legacy invoice line (no orderItemId) with a free live line re-claims by product", async () => {
    seedVoidA({}, { orderItemId: null });
    await service.unvoidInvoice("inv-a");
    expect(statusOfA()).toBe("DRAFT");
    expect(db.line("oi-1").invoicedQty).toBe(60);
  });

  describe("the void direction keeps its clamp (releases never go below 0 or above the line qty)", () => {
    const voidA = async () => {
      db.invoices.find((i) => i.id === "inv-a")!.status = "SENT";
      (prisma as any).invoice.findUnique.mockImplementation(async () => ({
        id: "inv-a",
        orderId: "ord-1",
        customerId: "cust-1",
        status: db.invoices.find((i) => i.id === "inv-a")!.status,
        payments: [],
        items: db.invoiceItems.filter((it) => it.invoiceId === "inv-a"),
      }));
      await (service as any).adjustInvoicedQtyForInvoice(prisma, "inv-a", "ord-1", -1);
    };

    it("releases A's qty from invoicedQty", async () => {
      seedVoidA();
      db.line("oi-1").invoicedQty = 100;
      await voidA();
      expect(db.line("oi-1").invoicedQty).toBe(40);
    });

    it("floors at 0 when more is released than was claimed", async () => {
      seedVoidA();
      db.line("oi-1").invoicedQty = 20;
      await voidA();
      expect(db.line("oi-1").invoicedQty).toBe(0);
    });

    it("caps at the line qty when the line was cut below what is invoiced", async () => {
      seedVoidA({ qty: 50 });
      db.line("oi-1").invoicedQty = 200;
      await voidA();
      expect(db.line("oi-1").invoicedQty).toBe(50);
    });
  });
});
