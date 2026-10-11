/**
 * SA-760 R-1 (closes B1096, Gap B, GH#2684): every order-invoice billing-state writer runs in a
 * transaction that takes ONE lock order before it reads anything it decides on:
 *
 *   Order row (lockOrderRow)  ->  the order's invoices FOR UPDATE, id-sorted  ->  re-read  ->  write.
 *
 * The writers: reconcileOrderDraftInvoice, reconcileOrderDeliveredInvoices, resyncOrderInvoicesForEdit
 * (and rebuildIssuedDepositMirrorOnDelivery, the delivered-basis deposit mirror rebuild). Before R-1
 * the callers that passed no tx (the order-edit tail, Mark Delivered's settle, the merge tail) ran the
 * sole-draft check and the deleteMany -> update on the unlocked forTenant() client: two concurrent
 * Mark Delivered doubled the lines (B1096) and a partial created between the check and the write was
 * overwritten (Gap B).
 *
 * These are op-log specs over the stateful fake in ./testing/split-invoice-fake-db.ts: the log records
 * every raw lock statement and the first reads/writes, so the ORDER of the statements is the assertion.
 * The real-Postgres race rows live in ./billing-lock-race-sa760.db.spec.ts.
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
import { AfterCommit } from "../common/after-commit";

describe("SA-760 R-1: one lock order for every billing-state writer", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: SplitInvoiceFakeDb;
  let log: string[];
  let onInvoiceLock: (() => void) | null;
  const mockLedger = {
    writeSaleEntries: jest.fn(),
    reverseInvoiceEntries: jest.fn(),
    syncInvoiceEntries: jest.fn(),
  };

  const sqlOf = (strings: TemplateStringsArray) => strings.join("?").replace(/\s+/g, " ").trim();

  beforeEach(async () => {
    log = [];
    onInvoiceLock = null;
    prisma = createMockPrisma();
    db = new SplitInvoiceFakeDb();
    db.install(prisma);
    const p = prisma as any;
    // Wrap the reads/writes whose position relative to the locks is the assertion.
    for (const [model, method] of [
      ["invoice", "findMany"],
      ["invoice", "findFirst"],
      ["invoice", "update"],
      ["invoiceItem", "deleteMany"],
      ["orderItem", "update"],
    ] as const) {
      const inner = p[model][method].getMockImplementation();
      p[model][method].mockImplementation((...a: unknown[]) => {
        log.push(`${model}.${method}`);
        return inner(...a);
      });
    }
    // One logging raw client for every tx (and the bare client), like a single connection.
    const raw = jest.fn((strings: TemplateStringsArray) => {
      const sql = sqlOf(strings);
      if (/FROM "Order" WHERE/.test(sql) && /FOR UPDATE/.test(sql)) log.push("lock:Order");
      else if (/FROM "Invoice" WHERE/.test(sql) && /FOR UPDATE/.test(sql)) {
        log.push("lock:Invoices");
        onInvoiceLock?.();
      } else log.push(`raw:${sql.slice(0, 40)}`);
      return Promise.resolve(0);
    });
    p.$executeRaw = raw;
    p.tenantTransaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      log.push("BEGIN");
      const result = await fn({ ...p.forTenant(), $executeRaw: raw, $queryRaw: jest.fn() });
      log.push("COMMIT");
      return result;
    });
    service = await buildSplitInvoicesService(InvoicesService, prisma, mockLedger);
    (service as any).gateway.emitInvoiceUpdated.mockImplementation(() => log.push("emit"));
  });

  const seedOrder = (lineOver: Record<string, unknown> = {}) =>
    db.addOrder(
      {
        id: "ord-1",
        customerId: "cust-1",
        orderNumber: "ORD-1",
        subtotal: 282,
        tax: 23.27,
        shippingFee: 0,
        total: 305.27,
      },
      [fakeOrderLine(lineOver)],
    );
  const seedMirrorDraft = () => {
    seedOrder();
    db.invoices.push({
      id: "inv-mirror",
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
      subtotal: 282,
      taxAmount: 23.27,
      total: 305.27,
      createdAt: new Date(Date.UTC(2026, 0, 1)),
    });
    db.invoiceItems.push({
      id: "ii-mirror-1",
      invoiceId: "inv-mirror",
      orderItemId: "oi-1",
      productId: "p-1",
      qty: 120,
      unitsPerBox: 12,
    });
  };

  /** The statements before the first read/write the writer decides on are exactly the two locks. */
  const expectLockOrderFirst = (from: number) => {
    const rest = log.slice(from);
    const orderAt = rest.indexOf("lock:Order");
    const invAt = rest.indexOf("lock:Invoices");
    const firstRead = rest.findIndex((s) => /^(invoice|invoiceItem|orderItem)\./.test(s));
    expect(orderAt).toBeGreaterThanOrEqual(0);
    expect(invAt).toBeGreaterThan(orderAt); // Order before Invoice (SA-218)
    expect(firstRead).toBeGreaterThan(invAt); // the sole-draft check / lines read UNDER the locks
  };

  describe("reconcileOrderDraftInvoice", () => {
    it("with no tx: opens its own transaction and locks Order then Invoices before the first read", async () => {
      seedMirrorDraft();
      await service.reconcileOrderDraftInvoice("ord-1", { basis: "order" });
      expect(log[0]).toBe("BEGIN");
      expectLockOrderFirst(0);
      expect(log[log.length - 1]).toBe("COMMIT"); // every write inside the transaction
      expect(log.indexOf("invoice.update")).toBeLessThan(log.lastIndexOf("COMMIT"));
    });

    it("with a caller tx: locks on THAT tx first and opens no second transaction", async () => {
      seedMirrorDraft();
      const tx = { ...(prisma as any).forTenant(), $executeRaw: (prisma as any).$executeRaw };
      await service.reconcileOrderDraftInvoice("ord-1", {
        basis: "order",
        tx,
        after: new AfterCommit(),
      });
      expect((prisma as any).tenantTransaction).not.toHaveBeenCalled();
      expectLockOrderFirst(0);
    });

    it("Gap B: a partial created while it waited for the lock is seen by the re-read, and nothing is overwritten", async () => {
      seedMirrorDraft();
      // The moment the Invoice lock is granted, a concurrent createPartialFromOrder has already
      // committed a second order-linked draft (it held the Order row until now).
      onInvoiceLock = () => {
        if (db.invoices.some((i) => i.id === "inv-partial")) return;
        db.invoices.push({
          ...db.invoices[0],
          id: "inv-partial",
          invoiceNumber: "INV-2",
          createdAt: new Date(Date.UTC(2026, 0, 2)),
        });
        db.invoiceItems.push({
          id: "ii-partial-1",
          invoiceId: "inv-partial",
          orderItemId: "oi-1",
          productId: "p-1",
          qty: 72,
          unitsPerBox: 12,
        });
      };
      const res = await service.reconcileOrderDraftInvoice("ord-1", { basis: "order" });
      expect(res).toBe("partials");
      expect(db.invoiceUpdateCalls).toHaveLength(0);
    });

    it("a deposit mirror's realtime emit leaves only after the transaction committed", async () => {
      seedOrder();
      db.invoices.push({
        id: "inv-dep",
        orderId: "ord-1",
        customerId: "cust-1",
        tenantId: "test-tenant",
        invoiceNumber: "INV-D",
        status: "SENT",
        deliveryBatchId: null,
        depositPercent: 50,
        discount: 0,
        shippingFee: 0,
        dueDate: null,
        subtotal: 282,
        taxAmount: 23.27,
        total: 305.27,
        createdAt: new Date(Date.UTC(2026, 0, 1)),
      });
      db.invoiceItems.push({
        id: "ii-dep-1",
        invoiceId: "inv-dep",
        orderItemId: "oi-1",
        productId: "p-1",
        qty: 120,
        unitsPerBox: 12,
      });
      await service.reconcileOrderDraftInvoice("ord-1", { basis: "order" });
      expect(log).toContain("COMMIT"); // its own transaction
      expect(log).toContain("emit");
      expect(log.indexOf("emit")).toBeGreaterThan(log.lastIndexOf("COMMIT"));
    });
  });

  describe("resyncOrderInvoicesForEdit", () => {
    it("with no tx: its own transaction, Order then Invoices locked before any invoice read", async () => {
      seedMirrorDraft();
      await service.resyncOrderInvoicesForEdit("ord-1");
      expect(log[0]).toBe("BEGIN");
      expectLockOrderFirst(0);
    });

    it("with a caller tx: locks on that tx before the first read", async () => {
      seedMirrorDraft();
      const tx = { ...(prisma as any).forTenant(), $executeRaw: (prisma as any).$executeRaw };
      await service.resyncOrderInvoicesForEdit("ord-1", tx, new AfterCommit());
      expect((prisma as any).tenantTransaction).not.toHaveBeenCalled();
      expectLockOrderFirst(0);
    });
  });

  describe("unvoidInvoice (the invoicedQty re-claim)", () => {
    const seedVoid = () => {
      seedOrder();
      db.invoices.push({
        id: "inv-v",
        orderId: "ord-1",
        customerId: "cust-1",
        tenantId: "test-tenant",
        invoiceNumber: "INV-V",
        status: "VOID",
        createdAt: new Date(Date.UTC(2026, 0, 1)),
      });
      db.invoiceItems.push({ id: "ii-v", invoiceId: "inv-v", orderItemId: "oi-1", qty: 60 });
    };
    const stubFindUnique = (statuses: string[]) => {
      let call = 0;
      (prisma as any).invoice.findUnique.mockImplementation(async () => {
        const status = statuses[Math.min(call++, statuses.length - 1)];
        return { id: "inv-v", orderId: "ord-1", status, payments: [] };
      });
    };

    it("locks Order then Invoice inside its own transaction before the invoice flip and the qty write", async () => {
      seedVoid();
      stubFindUnique(["VOID"]);
      await service.unvoidInvoice("inv-v");
      expectLockOrderFirst(log.indexOf("BEGIN"));
      expect(db.line("oi-1").invoicedQty).toBe(60);
    });

    it("409 ORDER_BILLING_CHANGED when the invoice was restored by someone else while it waited", async () => {
      seedVoid();
      stubFindUnique(["VOID", "DRAFT"]); // the pre-read says VOID, the locked re-read says DRAFT
      await expect(service.unvoidInvoice("inv-v")).rejects.toMatchObject({
        response: expect.objectContaining({ code: "ORDER_BILLING_CHANGED" }),
      });
      expect(db.line("oi-1").invoicedQty).toBe(0); // nothing re-claimed twice
    });
  });

  describe("reconcileOrderDeliveredInvoices", () => {
    it("with a caller tx: Order then Invoices locked before the draft list is read", async () => {
      seedMirrorDraft();
      const tx = { ...(prisma as any).forTenant(), $executeRaw: (prisma as any).$executeRaw };
      await service.reconcileOrderDeliveredInvoices("ord-1", tx);
      expectLockOrderFirst(0);
    });

    it("with no tx: its own transaction, locks first", async () => {
      seedMirrorDraft();
      await service.reconcileOrderDeliveredInvoices("ord-1");
      expect(log[0]).toBe("BEGIN");
      expectLockOrderFirst(0);
      expect(log[log.length - 1]).toBe("COMMIT");
    });
  });
});
