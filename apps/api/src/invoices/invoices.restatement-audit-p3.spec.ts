/**
 * SA-763r P-3 (R5.1 + M6, B1098), over the stateful fake in ./testing/split-invoice-fake-db.ts:
 *
 *  - a restatement of a NON-DRAFT invoice (the issued deposit mirror, and the post-delivery re-sync)
 *    writes ONE `invoice.revised` row {invoiceId, orderId, actor, totalBefore, totalAfter, linesChanged}
 *    in the restating transaction; the issue date is never part of the update;
 *  - when the new total is below what was paid, the invoice is held OUT of PAID (SENT, or OVERDUE past the
 *    due day) and an `invoice.overpaid-after-restatement` row {invoiceId, paid, total, overpaidBy} is written
 *    at BOTH restating sites;
 *  - an open DRAFT restatement writes neither row.
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
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";

describe("SA-763r P-3: restating an issued invoice is audited and never shows an overpaid invoice PAID", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: SplitInvoiceFakeDb;
  const mockLedger = { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() };

  beforeEach(async () => {
    prisma = createMockPrisma();
    db = new SplitInvoiceFakeDb();
    db.install(prisma);
    service = await buildSplitInvoicesService(InvoicesService, prisma, mockLedger);
  });

  const ORDER_TOTAL = 305.27;
  const PAYMENT = (amount: number) => ({ amount, status: "PAID", method: "CASH" });
  const seed = (status: string, over: Record<string, unknown> = {}, orderStatus = "CONFIRMED") => {
    db.addOrder(
      {
        id: "ord-1",
        customerId: "cust-1",
        orderNumber: "ORD-1",
        subtotal: 282,
        tax: 23.27,
        shippingFee: 0,
        total: ORDER_TOTAL,
        status: orderStatus,
      },
      [fakeOrderLine()],
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
      shippingFee: 0,
      dueDate: null,
      issueDate: new Date("2026-03-01T00:00:00Z"),
      subtotal: 282,
      taxAmount: 23.27,
      total: ORDER_TOTAL,
      payments: [],
      createdAt: new Date(Date.UTC(2026, 0, 1)),
      ...over,
    });
    db.invoiceItems.push({
      id: "ii-1",
      invoiceId: "inv-1",
      orderItemId: "oi-1",
      productId: "p-1",
      qty: 120,
      unitsPerBox: 12,
      subtotal: 282,
    });
  };
  /** The order edit: the 10-box line is cut to 5 boxes (60 pieces) -> 141.00 + 11.63 tax = 152.63. */
  const cutLineInHalf = () => {
    Object.assign(db.line("oi-1"), { qty: 60, boxes: 5, subtotal: 141 });
    Object.assign(db.orders.get("ord-1")!, { subtotal: 141, tax: 11.63, total: 152.63 });
  };
  const auditRows = () =>
    (prisma as any).auditLog.create.mock.calls.map((c: any[]) => c[0].data as any);
  const actions = () => auditRows().map((r: any) => r.action);

  describe("site 1: the issued deposit mirror (reconcileOrderDraftInvoice)", () => {
    const seedMirror = (over: Record<string, unknown> = {}) =>
      seed("SENT", { depositPercent: 50, payments: [PAYMENT(ORDER_TOTAL)], ...over });

    it("prior PAID, the edit shrinks the total below what was paid: SENT (not PAID), revised + overpaid rows, date kept", async () => {
      seedMirror();
      cutLineInHalf();
      await service.reconcileOrderDraftInvoice("ord-1", { basis: "order", actor: "user-1" });

      expect(db.invoices[0].total).toBe(152.63);
      expect(db.invoices[0].status).toBe("SENT"); // master: PAID (recomputeStatus on paid >= total)
      expect(actions()).toEqual([
        AUDIT_ACTIONS.INVOICE_REVISED,
        AUDIT_ACTIONS.INVOICE_OVERPAID_AFTER_RESTATEMENT,
      ]);
      const [revised, overpaid] = auditRows();
      expect(revised).toMatchObject({ entityType: "invoice", entityId: "inv-1", userId: "user-1" });
      expect(revised.meta).toEqual({
        invoiceId: "inv-1",
        orderId: "ord-1",
        actor: "user-1",
        totalBefore: ORDER_TOTAL,
        totalAfter: 152.63,
        linesChanged: 1,
      });
      expect(overpaid.meta).toEqual({
        invoiceId: "inv-1",
        paid: ORDER_TOTAL,
        total: 152.63,
        overpaidBy: 152.64,
        actor: "user-1",
      });
      // the issue date is never part of a revision
      expect(db.invoiceUpdateCalls).toHaveLength(1);
      expect(db.invoiceUpdateCalls[0].data).not.toHaveProperty("issueDate");
      expect(db.invoices[0].issueDate).toEqual(new Date("2026-03-01T00:00:00Z"));
    });

    it("past its due day the overpaid invoice is OVERDUE, still never PAID", async () => {
      seedMirror({ dueDate: new Date("2026-01-15T00:00:00Z") });
      cutLineInHalf();
      await service.reconcileOrderDraftInvoice("ord-1", { basis: "order", actor: "user-1" });
      expect(db.invoices[0].status).toBe("OVERDUE");
    });

    it("not overpaid (paid exactly the new total): stays PAID, one revised row, no overpaid row", async () => {
      seedMirror({ payments: [PAYMENT(152.63)] });
      cutLineInHalf();
      await service.reconcileOrderDraftInvoice("ord-1", { basis: "order", actor: "user-1" });
      expect(db.invoices[0].status).toBe("PAID");
      expect(actions()).toEqual([AUDIT_ACTIONS.INVOICE_REVISED]);
    });
  });

  describe("site 2: the post-delivery re-sync (resyncOrderInvoicesForEdit)", () => {
    it("prior PAID, the edit overpays: SENT (not PAID), revised + overpaid rows with the actor", async () => {
      seed("PAID", { payments: [PAYMENT(ORDER_TOTAL)] }, "DELIVERED");
      cutLineInHalf();
      const out = await service.resyncOrderInvoicesForEdit("ord-1", undefined, undefined, "user-9");

      expect(out).toHaveLength(1);
      expect(db.invoices[0].status).toBe("SENT"); // master: PAID
      expect(actions()).toEqual([
        AUDIT_ACTIONS.INVOICE_REVISED,
        AUDIT_ACTIONS.INVOICE_OVERPAID_AFTER_RESTATEMENT,
      ]);
      expect(auditRows()[0].meta).toMatchObject({
        invoiceId: "inv-1",
        orderId: "ord-1",
        actor: "user-9",
        totalBefore: ORDER_TOTAL,
        totalAfter: 152.63,
        linesChanged: 1,
      });
      expect(auditRows()[1].meta).toMatchObject({ overpaidBy: 152.64, actor: "user-9" });
      expect(db.invoiceUpdateCalls[0].data).not.toHaveProperty("issueDate");
    });

    it("an increase after final is allowed: PAID -> PARTIAL with a balance due, one revised row, no overpaid row", async () => {
      seed("PAID", { payments: [PAYMENT(ORDER_TOTAL)] }, "DELIVERED");
      Object.assign(db.line("oi-1"), { qty: 132, boxes: 11, subtotal: 310.2 });
      Object.assign(db.orders.get("ord-1")!, { subtotal: 310.2, tax: 25.59, total: 335.79 });
      await service.resyncOrderInvoicesForEdit("ord-1", undefined, undefined, "user-9");
      expect(db.invoices[0].status).toBe("PARTIAL");
      expect(actions()).toEqual([AUDIT_ACTIONS.INVOICE_REVISED]);
    });
  });

  describe("an open DRAFT is not a revision", () => {
    it("the pending mirror restated by an edit writes no audit row", async () => {
      seed("DRAFT");
      cutLineInHalf();
      await service.reconcileOrderDraftInvoice("ord-1", { basis: "order", actor: "user-1" });
      expect(db.invoices[0].total).toBe(152.63);
      expect(actions()).toEqual([]);
    });
  });
});
