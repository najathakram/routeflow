/**
 * SA-773 row 333(b): the pooled refund mint takes its row locks in the SAME order as the parked-reversal resolve, the refund
 * claim, cancel and the inline refund: the Return row first, then the Order, then the order's invoices id-sorted. Before, the mint
 * took the Order and the invoices first and the Return only at its link statement, the inverse of the resolve (Return, then
 * Order): the two deadlocked (40P01) when they met on one return. The retry backstop stays; when it is exhausted a return's mint
 * answers a coded, retryable 503 LOCK_UNAVAILABLE (nothing saved) instead of a 409 or a raw 500.
 */
import { Test } from "@nestjs/testing";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("CreditNotesService.create for a pooled return refund: lock order and exhausted retries (row 333b)", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let raw: string[];
  let attempts: number;
  let failWith: string | null;

  beforeEach(async () => {
    prisma = createMockPrisma();
    raw = [];
    attempts = 0;
    failWith = null;
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      attempts += 1;
      if (failWith) throw Object.assign(new Error("deadlock detected"), { code: failWith });
      return fn({
        ...prisma,
        $executeRaw: jest.fn((strings: TemplateStringsArray) => {
          raw.push(strings.join("?").replace(/\s+/g, " ").trim());
          return Promise.resolve(0);
        }),
      });
    });
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: { reverseCreditNoteEntries: jest.fn() } },
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn(), syncOrderInvoices: jest.fn() },
        },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("CN-1") },
        },
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
    prisma.invoice.count.mockResolvedValue(2); // 2 creditable invoices: the order pool
    prisma.invoice.findMany.mockResolvedValue([
      { id: "inv-1", items: [] },
      { id: "inv-2", items: [] },
    ]);
    prisma.creditNote.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "cn-new", ...args.data, customer: {} }),
    );
    prisma.return.findFirst.mockResolvedValue({ id: "ret-1", creditNoteId: null });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
  });

  const dto = { customerId: "c1", invoiceId: "inv-2", amount: 20 };
  const pooled = {
    ledgerReversedByReturn: true,
    returnId: "ret-1",
    pooledRefund: [{ productId: "p1", qty: 1 }],
  };
  const failure = async (p: Promise<unknown>): Promise<any> =>
    p.then(
      () => null,
      (e: any) => e,
    );

  it("takes the Return row first, then the Order, then the invoices (id-sorted): the resolve's order", async () => {
    await service.create(dto, pooled);
    const locks = raw.filter((t) => /FOR UPDATE/.test(t));
    expect(locks[0]).toMatch(/FROM "Return" WHERE id = \? .*FOR UPDATE/);
    expect(locks[1]).toMatch(/FROM "Order" WHERE id = \?.*FOR UPDATE/);
    expect(locks[2]).toMatch(/FROM "Invoice" WHERE id = \?.*FOR UPDATE/);
  });

  it("exhausted retries of a return's mint: 503 LOCK_UNAVAILABLE after 3 attempts, nothing created", async () => {
    failWith = "40P01";
    const err = await failure(service.create(dto, pooled));
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
    expect(attempts).toBe(3);
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
  });

  it("a standalone credit note keeps its 409 on exhausted retries (only a return's mint is the 503)", async () => {
    failWith = "40001";
    const err = await failure(service.create({ customerId: "c1", invoiceId: "inv-2", amount: 20 }));
    expect(err).toBeInstanceOf(ConflictException);
  });
});
