/**
 * B353 — return numbers were the last six digits of `Date.now()`
 * (`RET-<year>-<millis.slice(-6)>`), colliding every ~16.7 minutes (1e6 ms) of
 * wall-clock time under any real submission volume. Minting now goes through
 * `NumberingService.reserveNext("RETURN", { year, tenantId, tx })` — the same
 * collision-guarded counter invoices/estimates/credit notes already use — on
 * the CALLER's own transaction (never a nested one; see
 * `numbering.service.ts`'s `reserveNext` doc comment).
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ReturnsService.create — return numbering via NumberingService (B353)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let reserveNext: jest.Mock;
  let txReturn: { findMany: jest.Mock; create: jest.Mock };
  let txHandle: Record<string, unknown>;

  const order = {
    id: "ord-1",
    status: "DELIVERED",
    customerId: "cust-1",
    customer: { id: "cust-1", businessName: "Acme Co" },
    lineItems: [{ productId: "p1", qty: 10, unitPrice: 5 }],
    invoices: [{ id: "inv-1" }],
  };

  const dto = (over: Record<string, unknown> = {}) => ({
    orderId: "ord-1",
    reason: "DAMAGED",
    items: [{ productId: "p1", qty: 3 }],
    ...over,
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.order.findUnique.mockResolvedValue(order as any);
    prisma.getTenantId.mockReturnValue("tenant-1");

    txReturn = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockImplementation(({ data }: any) =>
          Promise.resolve({ id: "ret-1", returnNumber: data.returnNumber, items: [] }),
        ),
    };
    // Round 3 (independent review round 3, PR-2): order lookup + role check now run on `tx`
    // (inside the transaction) — reuse the same `prisma.order`/`prisma.customer` mock refs so
    // this file's own `prisma.order.findUnique.mockResolvedValue(order)` above still applies.
    txHandle = {
      return: txReturn,
      // PR-1a: the shared prior-returned reader (returnedPiecesByProduct) also queries
      // returnItem for INLINE-kind rows sourced from this order — always empty here,
      // no INLINE return exists in this suite.
      returnItem: { findMany: jest.fn().mockResolvedValue([]) },
      order: prisma.order,
      customer: prisma.customer,
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    prisma.tenantTransaction.mockImplementation((fn: any) => fn(txHandle));

    reserveNext = jest.fn().mockResolvedValue("RET-2026-0001");

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: CreditNotesService, useValue: {} },
        { provide: NumberingService, useValue: { reserveNext } },
      ],
    }).compile();

    service = mod.get(ReturnsService);
  });

  it('REG-B353-1: mints through reserveNext("RETURN", ...) — never a Date.now()-derived number', async () => {
    const ret = await service.create(dto(), "user-1", "OPERATOR");

    expect(reserveNext).toHaveBeenCalledTimes(1);
    expect(reserveNext).toHaveBeenCalledWith("RETURN", {
      year: expect.any(Number),
      tenantId: "tenant-1",
      tx: txHandle,
    });
    expect(ret.returnNumber).toBe("RET-2026-0001");
  });

  it("REG-B353-2: reserves on the CALLER's own transaction, never a nested one", async () => {
    await service.create(dto(), "user-1", "OPERATOR");

    // The `tx` opts.reserveNext receives is the SAME object create()'s own
    // tenantTransaction callback was handed — reserveNext never opened (or
    // could open) a second transaction of its own.
    const optsArg = reserveNext.mock.calls[0][1];
    expect(optsArg.tx).toBe(txHandle);
  });

  it("REG-B353-3: the current calendar year is what gets reserved against", async () => {
    await service.create(dto(), "user-1", "OPERATOR");

    const optsArg = reserveNext.mock.calls[0][1];
    expect(optsArg.year).toBe(new Date().getFullYear());
  });

  it("REG-B353-4: two returns created back to back both mint through reserveNext (no in-process fallback number ever slips through)", async () => {
    reserveNext.mockResolvedValueOnce("RET-2026-0001").mockResolvedValueOnce("RET-2026-0002");

    const first = await service.create(dto(), "user-1", "OPERATOR");
    const second = await service.create(dto(), "user-1", "OPERATOR");

    expect(reserveNext).toHaveBeenCalledTimes(2);
    expect(first.returnNumber).toBe("RET-2026-0001");
    expect(second.returnNumber).toBe("RET-2026-0002");
  });
});
