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

  const OTHER_MSG = "Another invoice now bills these items. Void it first.";
  const REDUCED_MSG =
    "The order line now holds less than this invoice bills. Raise the order line, or create a new invoice from the order.";
  /** SA-814d: the 409 carries a machine-readable `reason`; the server message is the matching copy. */
  const expectRefused = async (
    reason: "OTHER_INVOICE" | "LINE_REDUCED" = "OTHER_INVOICE",
  ): Promise<void> => {
    await expect(service.unvoidInvoice("inv-a")).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: "ORDER_BILLING_CHANGED",
        reason,
        message: reason === "OTHER_INVOICE" ? OTHER_MSG : REDUCED_MSG,
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

  describe("SA-814d: the refusal names its reason (clients pick copy from `reason`, never the message)", () => {
    it("OTHER_INVOICE: another live invoice bills part of the line", async () => {
      seedVoidA();
      billB(100);
      await expectRefused("OTHER_INVOICE");
    });

    it("LINE_REDUCED: no other invoice, but A bills more than the line now holds", async () => {
      seedVoidA({ qty: 50 }); // A bills 60, the line was cut to 50, nothing else invoiced
      await expectRefused("LINE_REDUCED");
      expect(db.line("oi-1").invoicedQty).toBe(0);
    });

    it("both apply on one line: OTHER_INVOICE wins", async () => {
      seedVoidA({ qty: 50 });
      db.line("oi-1").invoicedQty = 10; // another invoice bills 10 AND 60 > 50
      await expectRefused("OTHER_INVOICE");
    });

    it("decided across lines: any OTHER_INVOICE line wins over a LINE_REDUCED line", async () => {
      seedVoidA({ qty: 50 }); // oi-1: LINE_REDUCED
      db.orderItems.push(
        fakeOrderLine({ id: "oi-2", productId: "p-2", orderId: "ord-1", qty: 10 }),
      );
      db.invoiceItems.push({
        id: "ii-a2",
        invoiceId: "inv-a",
        orderItemId: "oi-2",
        productId: "p-2",
        qty: 10,
      });
      db.line("oi-2").invoicedQty = 10; // oi-2: OTHER_INVOICE
      await expectRefused("OTHER_INVOICE");
    });
  });

  describe("SA-814: an invoice line with no live order line is refused on unvoid (+1 only)", () => {
    it("a product line whose order line is gone (orderItemId null, product not on the order) -> 409 LINE_REDUCED, no write", async () => {
      seedVoidA({}, { orderItemId: null, productId: "p-gone" });
      await expectRefused("LINE_REDUCED");
      expect(db.line("oi-1").invoicedQty).toBe(0);
    });

    it("it is all-or-nothing: a matched line beside the unmatched one is not re-claimed", async () => {
      seedVoidA();
      db.invoiceItems.push({
        id: "ii-a2",
        invoiceId: "inv-a",
        orderItemId: null,
        productId: "p-gone",
        qty: 5,
      });
      await expectRefused("LINE_REDUCED");
      expect(db.line("oi-1").invoicedQty).toBe(0);
    });

    it("a free-form line (no productId, no orderItemId) has no order linkage by design and is NOT refused", async () => {
      seedVoidA();
      db.invoiceItems.push({
        id: "ii-a2",
        invoiceId: "inv-a",
        orderItemId: null,
        productId: null,
        qty: 1,
      });
      await service.unvoidInvoice("inv-a");
      expect(statusOfA()).toBe("DRAFT");
      expect(db.line("oi-1").invoicedQty).toBe(60);
    });

    it("the void direction (-1) still skips the unmatched line (no throw)", async () => {
      seedVoidA({}, { orderItemId: null, productId: "p-gone" });
      db.line("oi-1").invoicedQty = 30;
      await expect(
        (service as any).adjustInvoicedQtyForInvoice(prisma, "inv-a", "ord-1", -1),
      ).resolves.toBeUndefined();
      expect(db.line("oi-1").invoicedQty).toBe(30);
    });
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
    await expectRefused("LINE_REDUCED"); // nothing else bills it: the cancelled line holds 0
    expect(db.line("oi-1").invoicedQty).toBe(0);
  });

  it("(c) a legacy invoice line (no orderItemId) whose only product line is CANCELLED is refused", async () => {
    seedVoidA({ status: "CANCELLED" }, { orderItemId: null });
    await expectRefused("LINE_REDUCED");
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
