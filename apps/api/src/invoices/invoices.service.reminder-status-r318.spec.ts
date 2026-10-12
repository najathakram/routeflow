/**
 * ACTION-ITEMS row 318a (SA-770): `sendReminder` refused only VOID and PAID, so a DRAFT (never issued to
 * the customer) or a WRITTEN_OFF invoice that still carried a balance was reminded about. A reminder
 * demands money on an ISSUED, UNPAID invoice: the allowed set is SENT, VIEWED, PARTIAL, OVERDUE (the
 * same set as the web `canSendReminder` and `OPEN_INVOICE_STATUSES`); every other status is refused with
 * the coded 400 REMINDER_NOT_ISSUED before any PDF or email work. Built bare (no Nest module), like
 * invoices.service.reminder-no-balance-sa770.spec.ts.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { InvoiceStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { OPEN_INVOICE_STATUSES } from "./invoice-status-sets";

const NOT_ISSUED = "REMINDER_NOT_ISSUED"; // literal: pins the wire independently of the constant
const NO_BALANCE = "REMINDER_NO_BALANCE_DUE";

describe("InvoicesService.sendReminder - only an issued, unpaid invoice (row 318a)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: InvoicesService;
  let email: { isEmailConfigured: jest.Mock; sendInvoice: jest.Mock };
  let pdf: { getOrGenerate: jest.Mock };

  const invoice = (status: string) => ({
    id: "inv-1",
    invoiceNumber: "INV-1",
    status,
    total: 100,
    customer: { id: "c1", businessName: "Acme", contactName: null, email: "buyer@example.com" },
    items: [],
    payments: [], // the full 100 is still owed
  });

  beforeEach(() => {
    prisma = createMockPrisma();
    email = {
      isEmailConfigured: jest.fn().mockResolvedValue(false), // a reminder past the refusals stops here
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

  it.each([InvoiceStatus.DRAFT, InvoiceStatus.WRITTEN_OFF, InvoiceStatus.VOID, InvoiceStatus.PAID])(
    "%s with a balance on the books: a coded 400, no PDF or email work",
    async (status) => {
      prisma.invoice.findUnique.mockResolvedValue(invoice(status));
      const err = await service.sendReminder("inv-1").catch((e) => e);
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toMatchObject({ code: NOT_ISSUED });
      expect(email.isEmailConfigured).not.toHaveBeenCalled();
      expect(pdf.getOrGenerate).not.toHaveBeenCalled();
      expect(email.sendInvoice).not.toHaveBeenCalled();
    },
  );

  it.each(["SENT", "VIEWED", "PARTIAL", "OVERDUE"])(
    "%s with a balance: gets past the refusals (reaches the email-setup check)",
    async (status) => {
      prisma.invoice.findUnique.mockResolvedValue(invoice(status));
      const err = await service.sendReminder("inv-1").catch((e) => e);
      expect(err.getResponse()).not.toMatchObject({ code: NOT_ISSUED });
      expect(err.getResponse()).not.toMatchObject({ code: NO_BALANCE });
      expect(email.isEmailConfigured).toHaveBeenCalled();
    },
  );

  it("the allowed set is exactly OPEN_INVOICE_STATUSES, so a new status is decided in one place", () => {
    expect([...OPEN_INVOICE_STATUSES].sort()).toEqual(["OVERDUE", "PARTIAL", "SENT", "VIEWED"]);
    const refused = Object.values(InvoiceStatus).filter(
      (s) => !(OPEN_INVOICE_STATUSES as readonly string[]).includes(s),
    );
    expect(refused.sort()).toEqual(["DRAFT", "PAID", "VOID", "WRITTEN_OFF"]);
  });
});
