/**
 * SA-770 (row 294) review fold: a payment reminder demands a balance. `sendReminder` refused only VOID
 * and PAID, so an exactly-paid or overpaid invoice still SENT (P-3 keeps an overpaid one out of PAID)
 * emailed a "$0.00 balance due" reminder. It now refuses `balanceDue <= 0` with a coded 400, before any
 * PDF or email work. Built bare (no Nest module): sendReminder's first steps only touch `prisma`,
 * `emailService`, `pdfService` and `systemConfig`.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { InvoicesService } from "./invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";

const CODE = "REMINDER_NO_BALANCE_DUE"; // literal: pins the wire independently of the constant

describe("InvoicesService.sendReminder — refuses an invoice with no balance due (SA-770)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: InvoicesService;
  let email: { isEmailConfigured: jest.Mock; sendInvoice: jest.Mock };
  let pdf: { getOrGenerate: jest.Mock };

  const invoice = (status: string, total: number, payments: any[]) => ({
    id: "inv-1",
    invoiceNumber: "INV-1",
    status,
    total,
    customer: { id: "c1", businessName: "Acme", contactName: null, email: "buyer@example.com" },
    items: [],
    payments,
  });
  const pay = (amount: number, status = "PAID", method = "CASH") => ({ amount, status, method });

  beforeEach(() => {
    prisma = createMockPrisma();
    email = {
      isEmailConfigured: jest.fn().mockResolvedValue(false), // a reminder that gets past the refusal stops here
      sendInvoice: jest.fn(),
    };
    pdf = { getOrGenerate: jest.fn() };
    service = Object.create(InvoicesService.prototype) as InvoicesService;
    Object.assign(service as any, {
      prisma,
      emailService: email,
      pdfService: pdf,
      systemConfig: { get: jest.fn().mockResolvedValue(null) },
    });
  });

  it.each([
    ["exactly paid, still SENT", "SENT", 100, [pay(100)]],
    ["overpaid, still SENT (P-3)", "SENT", 100, [pay(110)]],
    ["overpaid, still OVERDUE", "OVERDUE", 100, [pay(150)]],
    [
      "settled by a credit note + advance",
      "VIEWED",
      100,
      [pay(60, "PAID", "CREDIT_NOTE"), pay(40, "PAID", "ADVANCE")],
    ],
  ])("%s: a coded 400, and no PDF or email work", async (_label, status, total, payments) => {
    prisma.invoice.findUnique.mockResolvedValue(invoice(status, total, payments));
    const err = await service.sendReminder("inv-1").catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ code: CODE });
    expect(email.isEmailConfigured).not.toHaveBeenCalled();
    expect(pdf.getOrGenerate).not.toHaveBeenCalled();
    expect(email.sendInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ["unpaid", [] as any[]],
    ["partial", [pay(90)]],
    ["a DRAFT payment does not reduce the balance", [pay(100, "DRAFT")]],
  ])("%s: still a reminder (gets past the refusal)", async (_label, payments) => {
    prisma.invoice.findUnique.mockResolvedValue(invoice("SENT", 100, payments));
    const err = await service.sendReminder("inv-1").catch((e) => e);
    expect(err.getResponse()).not.toMatchObject({ code: CODE });
    expect(email.isEmailConfigured).toHaveBeenCalled(); // reached the email-setup check
  });

  it("the VOID / PAID refusals are unchanged", async () => {
    prisma.invoice.findUnique.mockResolvedValue(invoice("PAID", 100, [pay(100)]));
    await expect(service.sendReminder("inv-1")).rejects.toThrow(/VOID or PAID/);
  });
});
