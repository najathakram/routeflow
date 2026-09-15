/**
 * REG-RET-IDEM — a retried POST /returns carrying the same Idempotency-Key must
 * be a no-op that returns the FIRST return.
 *
 * The reported failure: a driver's return screen is remounted (or the offline
 * queue replays, or a second device submits), the client re-derives the same
 * payload, and a SECOND PENDING return is created for the same physical goods.
 * Once both are approved that is a double customer credit, and the cumulative
 * over-return guard cannot see it — each submission is individually within the
 * ordered qty only when the first one has not yet been counted, and even when it
 * is, the operator-facing failure is a hard 400 on a legitimate retry.
 *
 * The pins below cover the three things that can regress: the replay is
 * collapsed, the scope is tenant- AND order-specific, and — the important one —
 * a request with NO header behaves exactly as it did before this change.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { IdempotencyService } from "../common/idempotency.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ReturnsService.create — Idempotency-Key replay guard (REG-RET-IDEM)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let gateway: { emitReturnCreated: jest.Mock };
  let txReturn: { findMany: jest.Mock; create: jest.Mock };
  let store: Map<string, unknown>;
  let idempotency: { check: jest.Mock; save: jest.Mock; keyHash: jest.Mock };

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

    txReturn = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: "ret-1", returnNumber: "RET-2026-1", items: [] }),
    };
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      fn({ return: txReturn, $executeRaw: jest.fn().mockResolvedValue(0), $queryRaw: jest.fn() }),
    );

    // A real in-memory stand-in rather than a bare jest.fn, so the SECOND call
    // genuinely reads back what the first stored — under the same scoping rule
    // the production service uses.
    store = new Map<string, unknown>();
    idempotency = {
      keyHash: jest.fn((key: string, scope: string) => `${scope}:${key}`),
      check: jest.fn(async (key: string, scope: string) => store.get(`${scope}:${key}`) ?? null),
      save: jest.fn(async (key: string, scope: string, response: unknown) => {
        store.set(`${scope}:${key}`, response);
      }),
    };

    gateway = { emitReturnCreated: jest.fn() };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: gateway },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: CreditNotesService, useValue: {} },
        { provide: IdempotencyService, useValue: idempotency },
      ],
    }).compile();

    service = mod.get(ReturnsService);
  });

  it("REG-RET-IDEM-1 stores the first result under a tenant+order scoped key", async () => {
    const first = await service.create(dto(), "user-1", "DRIVER", "key-1");

    expect(txReturn.create).toHaveBeenCalledTimes(1);
    expect(idempotency.save).toHaveBeenCalledTimes(1);
    expect(idempotency.save).toHaveBeenCalledWith(
      "key-1",
      "returns.create:test-tenant:ord-1",
      first,
    );
    expect(gateway.emitReturnCreated).toHaveBeenCalledTimes(1);
  });

  it("REG-RET-IDEM-2 a REPLAY with the same key creates nothing, re-emits nothing, and returns the first return", async () => {
    const first = await service.create(dto(), "user-1", "DRIVER", "key-1");

    txReturn.create.mockClear();
    prisma.tenantTransaction.mockClear();
    gateway.emitReturnCreated.mockClear();
    prisma.order.findUnique.mockClear();

    const replay = await service.create(dto(), "user-1", "DRIVER", "key-1");

    expect(replay).toBe(first);
    // No second row, no second transaction, and the check happens BEFORE the
    // order read — a replay must not even touch the database.
    expect(txReturn.create).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    // A second return.created would light up the operator dashboard twice.
    expect(gateway.emitReturnCreated).not.toHaveBeenCalled();
  });

  it("REG-RET-IDEM-3 a request with NO Idempotency-Key behaves exactly as before — the guard is never consulted", async () => {
    await service.create(dto(), "user-1", "DRIVER");

    expect(idempotency.check).not.toHaveBeenCalled();
    expect(idempotency.save).not.toHaveBeenCalled();
    expect(txReturn.create).toHaveBeenCalledTimes(1);
    expect(gateway.emitReturnCreated).toHaveBeenCalledTimes(1);

    // And two key-less submissions both land, exactly as today: two genuinely
    // separate partial returns on one order is a real workflow.
    await service.create(dto(), "user-1", "DRIVER");
    expect(txReturn.create).toHaveBeenCalledTimes(2);
  });

  it("REG-RET-IDEM-4 the same key under a DIFFERENT order is a different scope and is not collapsed", async () => {
    await service.create(dto(), "user-1", "DRIVER", "key-1");

    prisma.order.findUnique.mockResolvedValue({ ...order, id: "ord-2" } as any);
    await service.create(dto({ orderId: "ord-2" }), "user-1", "DRIVER", "key-1");

    expect(txReturn.create).toHaveBeenCalledTimes(2);
    expect(idempotency.save).toHaveBeenLastCalledWith(
      "key-1",
      "returns.create:test-tenant:ord-2",
      expect.anything(),
    );
  });

  it("REG-RET-IDEM-5 FAIL-OPEN is observable: if check() misses on a replay (the service-level DB-error case pinned by idempotency.service.spec.ts REG-IDEM-SVC-4) the SECOND submission still lands rather than the request failing", async () => {
    // Seed the store with a genuine first submission under key-1 — a bare
    // mockResolvedValue(null) with an empty store is indistinguishable from
    // "no prior submission" and can never fail; this reaches the state where
    // fail-open is actually doing something: a key IS on record, but the
    // lookup misses anyway.
    await service.create(dto(), "user-1", "DRIVER", "key-1");
    txReturn.create.mockClear();
    gateway.emitReturnCreated.mockClear();

    // Force the lookup to miss on the replay even though the first result is
    // in the store — this is what a transient DB read failure degrades to at
    // the IdempotencyService level (it never rejects; it resolves null).
    idempotency.check.mockResolvedValueOnce(null);

    await service.create(dto(), "user-1", "DRIVER", "key-1");

    // The replay guard missed, so this is a genuine SECOND write and a
    // SECOND emit — proof the fail-open path does not 500 (or silently
    // drop) the request. If check() started rejecting instead of resolving
    // null (breaking the service-level fail-open contract pinned by
    // idempotency.service.spec.ts REG-IDEM-SVC-4), this call never happens
    // and the counts below go to 0.
    expect(txReturn.create).toHaveBeenCalledTimes(1);
    expect(gateway.emitReturnCreated).toHaveBeenCalledTimes(1);
  });
});
