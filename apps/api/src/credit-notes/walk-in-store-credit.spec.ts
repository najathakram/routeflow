/**
 * W-913 (SA-932 §B, red case 3): no credit note is ever written on the walk-in account. Both credit-note writers
 * (`mintStandaloneInTx`, `insertCreditNoteInTx`) and the manual create() they back refuse a walk-in customer with
 * 409 WALK_IN_STORE_CREDIT_REFUSED before any row is written. The reissue funnels through `insertCreditNoteInTx`
 * (pinned by credit-note-writers.ast.spec.ts and proven on Postgres in walk-in-store-credit.db.spec.ts).
 */
import { Test } from "@nestjs/testing";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

const refusalOf = async (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => null,
    (e: any) => ({ status: e?.getStatus?.(), ...(e?.getResponse?.() ?? { name: e?.name }) }),
  );

const REFUSED = {
  status: 409,
  code: "WALK_IN_STORE_CREDIT_REFUSED",
  message: "Nothing changed. A walk-in return is refunded at the till.",
};

describe("credit-note writers refuse the walk-in customer (W-913 §B)", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let numbering: { reserveNext: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    numbering = { reserveNext: jest.fn().mockResolvedValue("CN-2026-0001") };
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: { settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0 }) },
        },
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn(), syncOrderInvoices: jest.fn() },
        },
        { provide: NumberingService, useValue: numbering },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
    prisma.creditNote.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "cn-new", ...args.data }),
    );
  });

  const customerIs = (isWalkIn: boolean | null | undefined) =>
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", businessName: "Acme", isWalkIn });

  it("mintStandaloneInTx (the inline capture's mint) refuses a walk-in; no row is written", async () => {
    customerIs(true);
    const body = await refusalOf(
      service.mintStandaloneInTx(prisma, { customerId: "cust-1", amount: 30 }, "CN-1", "t1"),
    );
    expect(body).toMatchObject(REFUSED);
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
  });

  it("insertCreditNoteInTx (create() and the reissue) refuses a walk-in; no row is written", async () => {
    customerIs(true);
    const body = await refusalOf(
      service.insertCreditNoteInTx(
        prisma,
        {
          creditNoteNumber: "CN-1",
          customerId: "cust-1",
          invoiceId: null,
          amount: 30,
          expiresAt: null,
        },
        [],
        "t1",
        { id: "cust-1", businessName: "Acme" },
      ),
    );
    expect(body).toMatchObject(REFUSED);
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
  });

  it("a manual credit note on the walk-in customer is 409 before a number is reserved or a row written", async () => {
    customerIs(true);
    const body = await refusalOf(service.create({ customerId: "cust-1", amount: 30 } as any));
    expect(body).toMatchObject(REFUSED);
    expect(numbering.reserveNext).not.toHaveBeenCalled();
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
  });

  it.each([
    ["isWalkIn false", false],
    ["isWalkIn null (every legacy row)", null],
    ["isWalkIn absent", undefined],
  ])("a named customer (%s) still gets the credit note (red case 5)", async (_n, flag) => {
    customerIs(flag);
    const cn = await service.mintStandaloneInTx(
      prisma,
      { customerId: "cust-1", amount: 30 },
      "CN-1",
      "t1",
    );
    expect(cn).toMatchObject({ id: "cn-new", customerId: "cust-1", amount: 30 });
    expect(prisma.creditNote.create).toHaveBeenCalledTimes(1);
  });

  it("a customer the tenant cannot see is still the existing 404, not a walk-in refusal", async () => {
    prisma.customer.findFirst.mockResolvedValue(null);
    const body = await refusalOf(
      service.mintStandaloneInTx(prisma, { customerId: "cust-x", amount: 30 }, "CN-1", "t1"),
    );
    expect(body).toMatchObject({ status: 404 });
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
  });
});
