import { Test } from "@nestjs/testing";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("CreditNotesService — W5c regulated reversal", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: { reverseCreditNoteEntries: jest.Mock; unreverseCreditNoteEntries: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    ledger = {
      reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
      unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: ledger },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
    prisma.creditNote.findFirst.mockResolvedValue(null); // nextCnNumber → CN-…-0001
    prisma.creditNote.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "cn-1", ...args.data, customer: {} }),
    );
  });

  const invoiceWith = (items: any[]) => ({ total: 100, customerId: "c1", items });

  it("reverses the ledger ONLY for an explicitly credited regulated line (line linkage)", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoiceWith([
        { id: "ii-1", subtotal: 30, qty: 3, trackedCategoryId: "cat-A", categoryTaxAmount: 6 },
        { id: "ii-2", subtotal: 70, qty: 7, trackedCategoryId: null, categoryTaxAmount: 0 },
      ]),
    );
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    // Operator credits the regulated line in full ($30). The non-regulated line is untouched.
    await service.create({
      customerId: "c1",
      invoiceId: "inv-1",
      amount: 30,
      items: [{ invoiceItemId: "ii-1", amount: 30 }],
    });

    const itemsData = prisma.creditNoteItem.createMany.mock.calls[0][0].data;
    expect(itemsData).toHaveLength(1); // only the regulated line gets a CreditNoteItem
    expect(itemsData[0]).toMatchObject({
      creditNoteId: "cn-1",
      tenantId: "test-tenant",
      trackedCategoryId: "cat-A",
      amount: 30,
      qty: 3,
      categoryTax: 6,
    });
    expect(ledger.reverseCreditNoteEntries).toHaveBeenCalledWith(
      expect.objectContaining({ creditNoteId: "cn-1" }),
    );
  });

  it("does NOT reverse the regulated ledger for a lump-sum credit with no line linkage", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoiceWith([
        { id: "ii-1", subtotal: 100, qty: 10, trackedCategoryId: "cat-A", categoryTaxAmount: 0 },
      ]),
    );
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    await service.create({ customerId: "c1", invoiceId: "inv-1", amount: 40 }); // no items
    expect(prisma.creditNoteItem.createMany).not.toHaveBeenCalled();
    expect(ledger.reverseCreditNoteEntries).not.toHaveBeenCalled();
  });

  it("crediting only a NON-regulated line never reverses regulated excise (no misattribution)", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoiceWith([
        { id: "ii-reg", subtotal: 50, qty: 5, trackedCategoryId: "cat-A", categoryTaxAmount: 0 },
        { id: "ii-std", subtotal: 50, qty: 5, trackedCategoryId: null, categoryTaxAmount: 0 },
      ]),
    );
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    await service.create({
      customerId: "c1",
      invoiceId: "inv-1",
      amount: 50,
      items: [{ invoiceItemId: "ii-std", amount: 50 }], // credit the candy, not the tobacco
    });
    expect(prisma.creditNoteItem.createMany).not.toHaveBeenCalled();
    expect(ledger.reverseCreditNoteEntries).not.toHaveBeenCalled();
  });

  it("rejects line amounts that do not reconcile to the credit-note total", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoiceWith([
        { id: "ii-1", subtotal: 30, qty: 3, trackedCategoryId: "cat-A", categoryTaxAmount: 0 },
      ]),
    );
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    await expect(
      service.create({
        customerId: "c1",
        invoiceId: "inv-1",
        amount: 30,
        items: [{ invoiceItemId: "ii-1", amount: 20 }], // 20 != 30
      }),
    ).rejects.toThrow(/must sum to the credit note amount/);
  });

  it("rejects a credit line that is not on the source invoice", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoiceWith([
        { id: "ii-1", subtotal: 30, qty: 3, trackedCategoryId: "cat-A", categoryTaxAmount: 0 },
      ]),
    );
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    await expect(
      service.create({
        customerId: "c1",
        invoiceId: "inv-1",
        amount: 10,
        items: [{ invoiceItemId: "ii-nope", amount: 10 }],
      }),
    ).rejects.toThrow(/not on invoice/);
  });

  it("merges duplicate line references and REJECTS when the combined amount exceeds the line", async () => {
    // Two-line, $200 invoice so the header cap passes and the MERGED per-line cap is
    // what rejects the over-credit (the exact duplicate-invoiceItemId over-reversal vector).
    prisma.invoice.findUnique.mockResolvedValue({
      total: 200,
      customerId: "c1",
      items: [
        { id: "ii-1", subtotal: 100, qty: 10, trackedCategoryId: "cat-A", categoryTaxAmount: 0 },
        { id: "ii-2", subtotal: 100, qty: 10, trackedCategoryId: null, categoryTaxAmount: 0 },
      ],
    });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    await expect(
      service.create({
        customerId: "c1",
        invoiceId: "inv-1",
        amount: 180, // 0 + 180 <= 200 header cap OK
        items: [
          { invoiceItemId: "ii-1", amount: 90 },
          { invoiceItemId: "ii-1", amount: 90 }, // merged 180 > line ii-1 subtotal 100
        ],
      }),
    ).rejects.toThrow(/exceeds invoice line subtotal/);
  });

  it("merges duplicate line references into a single CreditNoteItem when within the line", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      invoiceWith([
        { id: "ii-1", subtotal: 100, qty: 10, trackedCategoryId: "cat-A", categoryTaxAmount: 0 },
      ]),
    );
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    await service.create({
      customerId: "c1",
      invoiceId: "inv-1",
      amount: 80,
      items: [
        { invoiceItemId: "ii-1", amount: 30 },
        { invoiceItemId: "ii-1", amount: 50 },
      ],
    });
    const itemsData = prisma.creditNoteItem.createMany.mock.calls[0][0].data;
    expect(itemsData).toHaveLength(1); // merged into one line
    expect(itemsData[0]).toMatchObject({ invoiceItemId: "ii-1", amount: 80, qty: 8 }); // 80/100 * 10
  });

  it("does NOT touch the ledger for a standalone credit note (no source invoice)", async () => {
    await service.create({ customerId: "c1", amount: 25 });
    expect(prisma.creditNoteItem.createMany).not.toHaveBeenCalled();
    expect(ledger.reverseCreditNoteEntries).not.toHaveBeenCalled();
  });

  it("rejects a credit that would exceed the invoice total", async () => {
    prisma.invoice.findUnique.mockResolvedValue({ total: 100, customerId: "c1", items: [] });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 80 } }); // 80 already credited
    await expect(
      service.create({ customerId: "c1", invoiceId: "inv-1", amount: 30 }),
    ).rejects.toThrow(/exceed invoice total/);
  });

  it("voidCreditNote un-reverses the ledger for an unused (ISSUED) credit", async () => {
    prisma.creditNote.findUnique.mockResolvedValue({ status: "ISSUED", amountUsed: 0 });
    prisma.creditNote.updateMany.mockResolvedValue({ count: 1 }); // race-free flip succeeds
    await service.voidCreditNote("cn-1");
    expect(prisma.creditNote.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "cn-1", amountUsed: 0 }),
        data: { status: "VOID" },
      }),
    );
    expect(ledger.unreverseCreditNoteEntries).toHaveBeenCalledWith(
      expect.objectContaining({ creditNoteId: "cn-1" }),
    );
  });

  it("refuses the void when a concurrent apply already consumed the credit (0 rows flipped)", async () => {
    // Guard read sees ISSUED/unused, but the race-free updateMany matches 0 rows.
    prisma.creditNote.findUnique.mockResolvedValue({ status: "ISSUED", amountUsed: 0 });
    prisma.creditNote.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.voidCreditNote("cn-1")).rejects.toThrow(/un-apply/i);
    expect(ledger.unreverseCreditNoteEntries).not.toHaveBeenCalled();
  });

  it("blocks voiding an APPLIED credit note (must un-apply first) — no ledger touch", async () => {
    prisma.creditNote.findUnique.mockResolvedValue({ status: "APPLIED", amountUsed: 110 });
    await expect(service.voidCreditNote("cn-1")).rejects.toThrow(/un-apply/i);
    expect(ledger.unreverseCreditNoteEntries).not.toHaveBeenCalled();
    expect(prisma.creditNote.updateMany).not.toHaveBeenCalled();
  });
});
