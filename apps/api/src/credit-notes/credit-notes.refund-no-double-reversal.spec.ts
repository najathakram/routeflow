import { Test } from "@nestjs/testing";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-628 / B946 (Opus self-review BLOCKER): a return REFUND credit note is itemised so the shared per-line headroom counts it,
 * but receive() already reversed the returned regulated goods in the ledger (reverseReturnEntries). The refund's CreditNoteItem
 * rows must therefore carry trackedCategoryId NULL (and no categoryTax), or insertCreditNoteInTx would reverse the same goods a
 * SECOND time (a partial return of a regulated line: sold 10, 4 returned, would file 8 reversed). The option is internal
 * (ReturnsService only): it is not on the controller DTO.
 */
describe("a refund credit note books NO second regulated reversal (ledgerReversedByReturn)", () => {
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
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("CN-1") },
        },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
    prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessName: "Acme" });
    prisma.creditNote.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "cn-1", ...args.data, customer: {} }),
    );
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    prisma.creditNoteItem.findMany.mockResolvedValue([]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.invoice.findFirst.mockResolvedValue({
      total: 100,
      customerId: "c1",
      status: "SENT",
      items: [
        {
          id: "ii-1",
          productId: "p1",
          subtotal: 100,
          qty: 10,
          trackedCategoryId: "cat-A",
          categoryTaxAmount: 10,
        },
      ],
    });
  });

  const dto = {
    customerId: "c1",
    invoiceId: "inv-1",
    amount: 40,
    items: [{ invoiceItemId: "ii-1", amount: 40, qty: 4 }],
  };
  const writtenItems = () =>
    prisma.creditNoteItem.createMany.mock.calls.flatMap((c: any) => c[0].data);

  it("ordinary create(): the regulated line's item keeps its category and the ledger reversal runs (unchanged)", async () => {
    await service.create(dto);
    expect(writtenItems()[0]).toMatchObject({ trackedCategoryId: "cat-A" });
    expect(ledger.reverseCreditNoteEntries).toHaveBeenCalledTimes(1);
  });

  it("refund create(dto, { ledgerReversedByReturn: true }): the item carries NO category and NO tax, and the ledger is NOT reversed again", async () => {
    await service.create(dto, { ledgerReversedByReturn: true });
    expect(writtenItems()[0]).toMatchObject({
      invoiceItemId: "ii-1",
      trackedCategoryId: null,
      categoryTax: 0,
    });
    expect(ledger.reverseCreditNoteEntries).not.toHaveBeenCalled();
  });

  it("SA-628b: a refund row may carry its qty at amount 0 (a paid line whose share of the pooled price is 0); a manual note may not", async () => {
    const zero = {
      ...dto,
      amount: 40,
      items: [
        { invoiceItemId: "ii-1", amount: 40, qty: 4 },
        { invoiceItemId: "ii-1", amount: 0, qty: 0 },
      ],
    };
    await expect(service.create(zero, { ledgerReversedByReturn: true })).resolves.toBeDefined();
    const bare = { ...dto, items: [{ invoiceItemId: "ii-1", amount: 0, qty: 1 }], amount: 1 };
    await expect(service.create(bare)).rejects.toMatchObject({
      response: { code: "CREDIT_NOTE_LINE_INVALID" },
    });
  });
});
