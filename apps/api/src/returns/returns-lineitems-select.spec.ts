/**
 * PR-1a fix-round F2 (red-first): `returns-pieces.util.ts`'s CANCELLED-line exclusion
 * and `position`-ordered axis pick are only real if the `order.lineItems` query each
 * caller issues actually SELECTS those fields. Before this fix, none of the four call
 * sites in returns.service.ts did — the exclusion was a silent no-op against a real
 * database, even though `returns-overreturn.spec.ts`'s "CANCELLED line doesn't count"
 * test passed, because that test's MOCK supplied `status`/`position` directly rather
 * than the service's real select clause producing them.
 *
 * These tests assert the actual `select` object each call site sends — the one thing
 * a canned-response mock can never prove. Each fails against the pre-fix code (the
 * `status` key was simply absent from all four).
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("returns.service.ts — every order.lineItems select fetches status (PR-1a fix-round F2)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: CreditNotesService, useValue: {} },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ReturnsService);
  });

  it("create()'s order read", async () => {
    prisma.order.findUnique.mockResolvedValue(null); // NotFoundException — call args still captured
    await service
      .create(
        { orderId: "ord-1", reason: "DAMAGED", items: [{ productId: "p1", qty: 1 }] },
        "user-1",
      )
      .catch(() => {});
    // create()'s order read runs inside tenantTransaction on `tx.order`, which the
    // default mock aliases to the same `prisma.order` surface (see prisma-mock.ts).
    expect(prisma.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          lineItems: expect.objectContaining({
            select: expect.objectContaining({ status: true }),
          }),
        }),
      }),
    );
  });

  it("findAll()'s order.lineItems select (embedded in the return.findMany include)", async () => {
    prisma.return.findMany.mockResolvedValue([]);
    await service.findAll({});
    expect(prisma.return.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          order: expect.objectContaining({
            select: expect.objectContaining({
              lineItems: expect.objectContaining({
                select: expect.objectContaining({ status: true }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("processRefund()'s order.lineItems select", async () => {
    prisma.return.findUnique.mockResolvedValue(null);
    await service.processRefund("ret-1").catch(() => {});
    expect(prisma.return.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          order: expect.objectContaining({
            select: expect.objectContaining({
              lineItems: expect.objectContaining({
                select: expect.objectContaining({ status: true }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("findOne()'s order.lineItems select", async () => {
    prisma.return.findUnique.mockResolvedValue(null);
    await service.findOne("ret-1").catch(() => {});
    expect(prisma.return.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          order: expect.objectContaining({
            select: expect.objectContaining({
              lineItems: expect.objectContaining({
                select: expect.objectContaining({ status: true }),
              }),
            }),
          }),
        }),
      }),
    );
  });
});
