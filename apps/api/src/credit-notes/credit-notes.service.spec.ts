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

  it("derives per-line CreditNoteItems from the source invoice + reverses the ledger", async () => {
    prisma.invoice.findUnique.mockResolvedValue({
      total: 100,
      customerId: "c1",
      items: [
        {
          id: "ii-1",
          subtotal: 30,
          qty: 3,
          trackedCategoryId: "cat-A",
          categoryTaxAmount: 6,
          product: { trackedCategoryId: "cat-A" },
        },
        {
          id: "ii-2",
          subtotal: 70,
          qty: 7,
          trackedCategoryId: null,
          categoryTaxAmount: 0,
          product: { trackedCategoryId: null },
        },
      ],
    });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    await service.create({ customerId: "c1", invoiceId: "inv-1", amount: 50 }); // fraction = 0.5

    const itemsData = prisma.creditNoteItem.createMany.mock.calls[0][0].data;
    expect(itemsData).toHaveLength(2);
    expect(itemsData.find((i: any) => i.invoiceItemId === "ii-1")).toMatchObject({
      creditNoteId: "cn-1",
      tenantId: "test-tenant",
      trackedCategoryId: "cat-A",
      amount: 15, // 30 * 0.5
      qty: 1.5, // 3 * 0.5
      categoryTax: 3, // 6 * 0.5
    });
    expect(ledger.reverseCreditNoteEntries).toHaveBeenCalledWith(
      expect.objectContaining({ creditNoteId: "cn-1" }),
    );
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

  it("voidCreditNote un-reverses the ledger", async () => {
    prisma.creditNote.update.mockResolvedValue({ id: "cn-1", status: "VOID" });
    await service.voidCreditNote("cn-1");
    expect(ledger.unreverseCreditNoteEntries).toHaveBeenCalledWith(
      expect.objectContaining({ creditNoteId: "cn-1" }),
    );
  });
});
