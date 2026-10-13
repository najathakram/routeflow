/**
 * SA-763r P-3 [L-O2] (red row 14) + the dunning nit.
 *
 * The operator's standalone payment may DELIBERATELY allocate more than an invoice's balance: it stays PAID
 * (unchanged behaviour) but now writes ONE `invoice.deliberate-overpayment` audit row
 * {invoiceId, paymentGroupId, overpaidBy, actor} in the same transaction. An exact or short payment writes
 * none. And a reminder email is refused for an invoice with nothing owing (an overpaid, possibly past-due
 * invoice): reminders key on the balance due, never on the status alone.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { InvoicesService } from "./invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { buildSplitInvoicesService } from "./testing/split-invoice-service";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { deriveInvoiceDetailFields } from "./invoice-detail-read";

describe("SA-763r P-3: deliberate standalone overpayment + no dunning on an overpaid invoice", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    service = await buildSplitInvoicesService(InvoicesService, prisma);
    const p = prisma as any;
    p.paymentCounter.upsert.mockResolvedValue({ id: "test-tenant", next: 3 });
    p.invoice.findFirst.mockResolvedValue({
      id: "inv-1",
      invoiceNumber: "INV-1",
      status: "SENT",
      total: 100,
      dueDate: null,
      payments: [],
    });
    p.invoicePayment.create.mockImplementation(async ({ data }: any) => ({ id: "pay-1", ...data }));
  });

  const pay = (amount: number) =>
    service.recordStandalonePayment(
      {
        customerId: "cust-1",
        totalAmount: amount,
        method: "CASH",
        allocations: [{ invoiceId: "inv-1", amount }],
      } as any,
      { actor: "op-1" },
    );
  const auditCalls = () => (prisma as any).auditLog.create.mock.calls.map((c: any[]) => c[0].data);
  const invoiceStatusWritten = () =>
    (prisma as any).invoice.update.mock.calls.map((c: any[]) => c[0].data.status).filter(Boolean);

  it("allocating 105 to a 100 invoice stays PAID and writes one deliberate-overpayment row (overpaidBy 5)", async () => {
    (prisma as any).invoicePayment.findMany.mockResolvedValue([
      { amount: 105, status: "PAID", method: "CASH" },
    ]);
    const out = await pay(105);
    expect(invoiceStatusWritten()).toEqual(["PAID"]);
    const rows = auditCalls();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: AUDIT_ACTIONS.INVOICE_DELIBERATE_OVERPAYMENT,
      entityType: "invoice",
      entityId: "inv-1",
      userId: "op-1",
    });
    expect(rows[0].meta).toEqual({
      invoiceId: "inv-1",
      paymentGroupId: out.paymentGroupId,
      overpaidBy: 5,
      actor: "op-1",
    });
  });

  it("an exact payment is PAID with no audit row; a short payment is PARTIAL with none", async () => {
    (prisma as any).invoicePayment.findMany.mockResolvedValue([
      { amount: 100, status: "PAID", method: "CASH" },
    ]);
    await pay(100);
    expect(invoiceStatusWritten()).toEqual(["PAID"]);
    expect(auditCalls()).toEqual([]);

    (prisma as any).invoice.update.mockClear();
    (prisma as any).invoicePayment.findMany.mockResolvedValue([
      { amount: 40, status: "PAID", method: "CASH" },
    ]);
    await pay(40);
    expect(invoiceStatusWritten()).toEqual(["PARTIAL"]);
    expect(auditCalls()).toEqual([]);
  });

  it("[L-O1] pay the DRAFT mirror 100, cut to 70 before hand-over, then send: stays SENT (never PAID), overpaidBy 30", async () => {
    const p = prisma as any;
    const paid = [{ amount: 100, status: "PAID", method: "CASH" }];
    const mirror = {
      id: "inv-1",
      orderId: null,
      customerId: "cust-1",
      invoiceNumber: "INV-1",
      status: "DRAFT",
      deliveryBatchId: null,
      total: 70, // the restated total, below what was paid
      dueDate: null,
      payments: paid,
    };
    // pre-read, the locked re-read inside markSent, then the post-send re-read the credit sweep makes
    p.invoice.findUnique
      .mockResolvedValueOnce(mirror)
      .mockResolvedValueOnce(mirror)
      .mockResolvedValue({ ...mirror, status: "SENT" });
    p.invoice.update.mockResolvedValue({ ...mirror, status: "SENT" });
    await service.send("inv-1", { suppressNotify: true });
    const written = p.invoice.update.mock.calls.map((c: any[]) => c[0].data.status).filter(Boolean);
    expect(written).toEqual(["SENT"]); // master: SENT then PAID (paid >= total)
    expect(deriveInvoiceDetailFields({ ...mirror, status: "SENT" }).overpaidBy).toBe(30);
  });

  describe("sendReminder keys on the balance due", () => {
    const stubInvoice = (paid: number) =>
      (prisma as any).invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        invoiceNumber: "INV-1",
        status: "SENT",
        total: 100,
        dueDate: new Date("2026-01-01T00:00:00Z"), // past due
        customer: { id: "cust-1", businessName: "Acme", contactName: "A", email: "a@acme.test" },
        items: [],
        payments: [{ amount: paid, status: "PAID", method: "CASH" }],
      });

    it("an overpaid past-due invoice gets no reminder", async () => {
      stubInvoice(130);
      const err: any = await service.sendReminder("inv-1").catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.REMINDER_NO_BALANCE_DUE });
    });

    it("an invoice with a balance due still reaches the reminder body (not refused for balance)", async () => {
      stubInvoice(40);
      const err: any = await service.sendReminder("inv-1").catch((e) => e);
      expect(err?.getResponse?.()?.code).not.toBe(API_ERROR_CODES.REMINDER_NO_BALANCE_DUE);
    });
  });
});
