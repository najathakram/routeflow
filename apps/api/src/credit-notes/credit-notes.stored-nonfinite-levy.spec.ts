/**
 * SA-816 (d)2 / register row 593: `validateAndBuildCnItems` priced the levy refund of a regulated line as
 * `roundMoney(Number(line.categoryTaxAmount ?? 0) * frac)`. A stored numeric NaN (node-pg binds a JS NaN as
 * 'NaN', NUMERIC accepts it) made that product NaN, and `roundMoney(NaN)` is 0: a silent $0 levy refund.
 * The stored value is now refused (400 MONEY_INVARIANT) BEFORE a number is reserved or a note is written.
 *
 * Master (static read, not run): the create below succeeded and `creditNoteItem.createMany` received
 * `categoryTax: 0`.
 */
import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { CreditNotesService } from "./credit-notes.service";
import { codeOf } from "./credit-note-errors";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("CreditNotesService: a stored non-finite levy is refused, not refunded as $0 (SA-816 (d)2)", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: { reverseCreditNoteEntries: jest.Mock };
  let reserveNext: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    ledger = { reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined) };
    reserveNext = jest.fn().mockResolvedValue("CN-2026-0001");
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RouteFlowGateway,
          useValue: { emitCreditNoteCreated: jest.fn(), emitCreditNoteVoided: jest.fn() },
        },
        { provide: RegulatedLedgerService, useValue: ledger },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NumberingService, useValue: { reserveNext } },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
    prisma.creditNote.findFirst.mockResolvedValue(null);
    prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessName: "Acme Retail" });
    prisma.creditNote.create.mockImplementation((args: { data: object }) =>
      Promise.resolve({ id: "cn-1", ...args.data, customer: {} }),
    );
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  });

  const creditRegulatedLine = (levy: unknown) => {
    prisma.invoice.findFirst.mockResolvedValue({
      total: 100,
      customerId: "c1",
      items: [
        { id: "ii-1", subtotal: 30, qty: 3, trackedCategoryId: "cat-A", categoryTaxAmount: levy },
        { id: "ii-2", subtotal: 70, qty: 7, trackedCategoryId: null, categoryTaxAmount: 0 },
      ],
    });
    return service.create({
      customerId: "c1",
      invoiceId: "inv-1",
      amount: 30,
      items: [{ invoiceItemId: "ii-1", amount: 30 }],
    });
  };

  it.each([
    ["the string 'NaN' (a raw pg row)", "NaN"],
    ["Prisma.Decimal('NaN') (a Prisma row)", new Prisma.Decimal("NaN")],
    ["the string 'Infinity'", "Infinity"],
    ["Prisma.Decimal('Infinity')", new Prisma.Decimal("Infinity")],
  ])("refuses %s with MONEY_INVARIANT and writes nothing", async (_label, nan) => {
    const err = await creditRegulatedLine(nan).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(codeOf(err)).toBe(API_ERROR_CODES.MONEY_INVARIANT);
    expect(reserveNext).not.toHaveBeenCalled(); // a rejected request burns no CREDIT_NOTE number
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
    expect(prisma.creditNoteItem.createMany).not.toHaveBeenCalled();
    expect(ledger.reverseCreditNoteEntries).not.toHaveBeenCalled();
  });

  it("control: a finite levy refunds its pro-rated share, exactly as before", async () => {
    await creditRegulatedLine(6);
    const itemsData = prisma.creditNoteItem.createMany.mock.calls[0][0].data;
    expect(itemsData[0]).toMatchObject({ trackedCategoryId: "cat-A", amount: 30, categoryTax: 6 });
  });
});
