/**
 * W-861 sibling sweep (SA-944 §3 MUST 4): `POST /invoices/:id/reopen` flips a PAID invoice to DRAFT with its payments
 * kept, and the DRAFT invoice edit then accepts a higher total, so a paid walk-in sale could still leave the shared
 * Walk-in customer owing. The reopen now calls the same `walkInSaleLocked` predicate: 409 WALK_IN_SALE_PAID, nothing
 * written. A named customer's PAID invoice reopens as before. On master the walk-in invoice reopens (DRAFT).
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { InvoicesService } from "./invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { buildSplitInvoicesService } from "./testing/split-invoice-service";

describe("W-861: reopening a paid walk-in sale's invoice", () => {
  let service: InvoicesService;
  let prisma: any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    service = await buildSplitInvoicesService(InvoicesService, prisma, {
      writeSaleEntries: jest.fn(),
      reverseInvoiceEntries: jest.fn(),
      settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
    });
    prisma.invoice.findUnique.mockResolvedValue({
      id: "inv-1",
      orderId: "ord-1",
      customerId: "cust-1",
      status: "PAID",
    });
    prisma.invoice.update.mockResolvedValue({ id: "inv-1", status: "DRAFT" });
    prisma.invoicePayment.findFirst.mockResolvedValue({ id: "pay-1" });
  });

  it("a walk-in sale's PAID invoice is refused 409 WALK_IN_SALE_PAID and nothing is written (master: DRAFT)", async () => {
    prisma.customer.findUnique.mockResolvedValue({ isWalkIn: true });
    await expect(service.reopenInvoice("inv-1")).rejects.toMatchObject({
      status: 409,
      response: { code: "WALK_IN_SALE_PAID" },
    });
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("a named customer's PAID invoice reopens as before", async () => {
    prisma.customer.findUnique.mockResolvedValue({ isWalkIn: false });
    await expect(service.reopenInvoice("inv-1")).resolves.toMatchObject({ status: "DRAFT" });
    expect(prisma.invoice.update).toHaveBeenCalled();
  });

  it("a non-PAID invoice keeps its 400", async () => {
    prisma.invoice.findUnique.mockResolvedValue({ id: "inv-1", status: "SENT", orderId: null });
    await expect(service.reopenInvoice("inv-1")).rejects.toMatchObject({ status: 400 });
  });
});
