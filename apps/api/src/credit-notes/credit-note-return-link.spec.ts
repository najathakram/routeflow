/**
 * SA-773 row 333(a): a return's credit note is linked (`Return.creditNoteId`) by a CAS INSIDE the mint transaction, for the
 * single-invoice (non-pooled) mint too, and a retry that finds the link already set returns that credit note: it never mints a
 * second. Before: the non-pooled link was a separate write after the commit, so a crash between the two left a credit note
 * nobody pointed at, and the retry minted another.
 */
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("CreditNotesService.create for a return: the link is a CAS in the mint transaction (row 333a)", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let reserveNext: jest.Mock;
  let emit: jest.Mock;
  let inTx: boolean;
  let linkInTx: boolean | null;
  /** the credit note the return already points at, when a retry arrives */
  let linked: { id: string } | null;

  beforeEach(async () => {
    prisma = createMockPrisma();
    inTx = false;
    linkInTx = null;
    linked = null;
    reserveNext = jest.fn().mockResolvedValue("CN-1");
    emit = jest.fn();
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      inTx = true;
      try {
        return await fn({ ...prisma, $executeRaw: jest.fn().mockResolvedValue(0) });
      } finally {
        inTx = false;
      }
    });
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: emit } },
        { provide: RegulatedLedgerService, useValue: { reverseCreditNoteEntries: jest.fn() } },
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn(), syncOrderInvoices: jest.fn() },
        },
        { provide: NumberingService, useValue: { reserveNext } },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
    prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessName: "Acme Retail" });
    prisma.invoice.findFirst.mockResolvedValue({
      total: 1000,
      customerId: "c1",
      status: "SENT",
      orderId: "ord-1",
      items: [],
    });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    prisma.invoice.count.mockResolvedValue(1);
    prisma.creditNote.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "cn-new", ...args.data, customer: {} }),
    );
    // the return's current link, as the pre-read and the in-transaction read see it
    prisma.return.findFirst.mockImplementation(async () => ({
      id: "ret-1",
      creditNoteId: linked?.id ?? null,
    }));
    prisma.creditNote.findFirst.mockImplementation(async ({ where }: any) =>
      linked && where?.id === linked.id
        ? {
            id: linked.id,
            creditNoteNumber: "CN-OLD",
            customerId: "c1",
            amount: 20,
            customer: { id: "c1" },
          }
        : null,
    );
    prisma.return.updateMany.mockImplementation(async () => {
      linkInTx = inTx;
      return { count: 1 };
    });
  });

  const dto = { customerId: "c1", invoiceId: "inv-1", amount: 20 };
  const mint = () => service.create(dto, { ledgerReversedByReturn: true, returnId: "ret-1" });

  it("a single-invoice return mint links the return in the mint transaction, with a CAS on creditNoteId: null, after the insert", async () => {
    const cn = await mint();
    expect(cn.id).toBe("cn-new");
    expect(prisma.return.updateMany).toHaveBeenCalledWith({
      where: { id: "ret-1", creditNoteId: null },
      data: { creditNoteId: "cn-new" },
    });
    expect(linkInTx).toBe(true);
    expect(prisma.return.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.creditNote.create.mock.invocationCallOrder[0],
    );
  });

  it("a retry whose return already points at a credit note gets THAT credit note: nothing minted, no number burned, nothing emitted", async () => {
    linked = { id: "cn-old" };
    const cn = await mint();
    expect(cn).toMatchObject({ id: "cn-old", creditNoteNumber: "CN-OLD" });
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
    expect(reserveNext).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("the link CAS losing a race (another mint linked first) rolls this mint back and answers with the winner's credit note", async () => {
    // the pre-read sees no link; by the time this transaction's CAS runs, another request linked cn-old
    let reads = 0;
    prisma.return.findFirst.mockImplementation(async () => ({
      id: "ret-1",
      creditNoteId: ++reads > 1 ? "cn-old" : null,
    }));
    prisma.creditNote.findFirst.mockImplementation(async ({ where }: any) =>
      where?.id === "cn-old"
        ? {
            id: "cn-old",
            creditNoteNumber: "CN-OLD",
            customerId: "c1",
            amount: 20,
            customer: { id: "c1" },
          }
        : null,
    );
    prisma.return.updateMany.mockResolvedValue({ count: 0 });
    const cn = await mint();
    expect(cn.id).toBe("cn-old");
    expect(emit).not.toHaveBeenCalled();
  });

  it("a lost CAS with no winner to hand back is a 409, never a silent second credit note", async () => {
    prisma.return.updateMany.mockResolvedValue({ count: 0 });
    await expect(mint()).rejects.toBeInstanceOf(ConflictException);
    expect(emit).not.toHaveBeenCalled();
  });
});
