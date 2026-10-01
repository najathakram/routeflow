import { BadRequestException } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-608g (SA-214: Order -> Invoice -> CreditNote, each set sorted): deleteInvoice takes the order
 * row, then the invoice row, BEFORE it reads what it is about to refuse or unlink, and re-reads under
 * those locks. Without the invoice lock, a reissue that commits a NEW note with `invoiceId = X`
 * between the read and the final delete is invisible to both, and the delete's SET NULL leaves an
 * UNSPENT, unmarked orphan (a provenance loss that bypasses B214). The real-Postgres two-connection
 * pin is invoice-delete-credit.db.spec.ts (SA-608g case).
 */
describe("InvoicesService.deleteInvoice: SA-608g lock order", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let log: string[];
  let self: any;
  const inv = (payments: unknown[] = [], orderId: string | null = "ord-1") => ({
    id: "inv-1",
    invoiceNumber: "INV-1",
    orderId,
    customerId: "cust-1",
    status: "DRAFT",
    total: 10,
    payments,
  });

  beforeEach(() => {
    prisma = createMockPrisma();
    log = [];
    const exec = jest.fn((strings: TemplateStringsArray, ...vals: unknown[]) => {
      log.push(`lock:${strings.join("?").match(/FROM "(\w+)"/)![1]}:${vals[0]}`);
      return Promise.resolve(0);
    });
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma, $executeRaw: exec }),
    );
    prisma.invoice.findUnique.mockImplementation(() => {
      log.push("read:invoice");
      return Promise.resolve(inv());
    });
    prisma.creditNote.findMany.mockImplementation(() => {
      log.push("read:sourced-notes");
      return Promise.resolve([]);
    });
    prisma.invoiceItem.deleteMany.mockResolvedValue({ count: 0 });
    prisma.invoice.delete.mockImplementation(() => {
      log.push("write:delete");
      return Promise.resolve({});
    });
    self = {
      prisma,
      ledger: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
      commissionEngine: { removeInvoiceCommission: jest.fn().mockResolvedValue(undefined) },
      gateway: { emitInvoiceUpdated: jest.fn() },
      adjustInvoicedQtyForInvoice: jest.fn().mockResolvedValue(undefined),
    };
  });

  const run = () => InvoicesService.prototype.deleteInvoice.call(self, "inv-1");

  it("reads the invoice (for its order), locks Order then Invoice, RE-READS, and only then reads the sourced notes and deletes", async () => {
    await run();
    expect(log.slice(0, 5)).toEqual([
      "read:invoice",
      "lock:Order:ord-1",
      "lock:Invoice:inv-1",
      "read:invoice",
      "read:sourced-notes",
    ]);
    expect(log.indexOf("write:delete")).toBeGreaterThan(log.indexOf("read:sourced-notes"));
  });

  it("never locks the invoice first (Invoice -> Order would invert SA-214 against an order-edit sync)", async () => {
    await run();
    expect(log.indexOf("lock:Order:ord-1")).toBeLessThan(log.indexOf("lock:Invoice:inv-1"));
  });

  it("an invoice with no order locks only the invoice", async () => {
    prisma.invoice.findUnique.mockImplementation(() => {
      log.push("read:invoice");
      return Promise.resolve(inv([], null));
    });
    await run();
    expect(log.filter((l) => l.startsWith("lock:"))).toEqual(["lock:Invoice:inv-1"]);
  });

  it("the payments refusal runs on the RE-READ: a payment recorded between the two reads is refused", async () => {
    prisma.invoice.findUnique
      .mockImplementationOnce(() => Promise.resolve(inv([])))
      .mockImplementationOnce(() => Promise.resolve(inv([{ id: "pay-1" }])));
    await expect(run()).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.invoice.delete).not.toHaveBeenCalled();
  });

  it("an invoice whose order link changed between the peek and the re-read is a 409 (the order lock would be the wrong one)", async () => {
    prisma.invoice.findUnique
      .mockImplementationOnce(() => Promise.resolve(inv()))
      .mockImplementationOnce(() => Promise.resolve(inv([], "ord-OTHER")));
    await expect(run()).rejects.toMatchObject({
      response: {
        code: "INVOICE_CHANGED_CONCURRENTLY",
        message: expect.stringMatching(/changed while/i),
      },
    });
    expect(prisma.invoice.delete).not.toHaveBeenCalled();
  });

  it("a missing invoice is a 404 before any lock is taken", async () => {
    prisma.invoice.findUnique.mockResolvedValue(null);
    await expect(run()).rejects.toThrow(/not found/i);
    expect(log.filter((l) => l.startsWith("lock:"))).toEqual([]);
  });

  it("an invoice deleted between the first read and the lock is a 404, not a crash", async () => {
    prisma.invoice.findUnique
      .mockImplementationOnce(() => Promise.resolve(inv()))
      .mockImplementationOnce(() => Promise.resolve(null));
    await expect(run()).rejects.toThrow(/not found/i);
    expect(prisma.invoice.delete).not.toHaveBeenCalled();
  });
});
