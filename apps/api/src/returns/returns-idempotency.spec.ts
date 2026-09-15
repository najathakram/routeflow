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
 * The pins below cover the things that can regress: the replay is collapsed,
 * the scope is tenant- AND submitter-specific (F1, PR-2 — a hand-built key
 * reused across two DIFFERENT users must not collide them onto one return), a
 * request with NO header behaves exactly as it did before this change, the
 * check-then-act race between two concurrent identical submissions is closed
 * by the F5 advisory lock, and a genuinely later submission (the store no
 * longer holds a prior record) still creates a new return.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { IdempotencyService } from "../common/idempotency.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

// F5 (independent review, PR-2): create() now wraps its whole check→order-lookup→transaction→save
// sequence in withAdvisoryLock (common/db-locks.ts) — the REAL implementation opens a Postgres
// connection, which a plain unit test has none of. Everything else in the module (LockTimeoutError,
// LOCK_FAMILIES, …) stays real via requireActual; only withAdvisoryLock is replaced.
//
// The fake is a genuine per-key promise-chain mutex — NOT a passthrough that just calls fn()
// immediately — so REG-RET-IDEM-7 below can prove the check-then-act race is actually closed
// (the second caller's check() only runs after the first caller's save() has landed), the same
// guarantee the real Postgres advisory lock gives. db-locks.spec.ts already proves the REAL
// primitive serializes; this proves ReturnsService uses it correctly.
const mockLockQueue = new Map<string, Promise<unknown>>();
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(
    async (opts: { family: string; key: string }, fn: () => Promise<unknown>) => {
      const qKey = `${opts.family}:${opts.key}`;
      const prior = mockLockQueue.get(qKey) ?? Promise.resolve();
      const mine = prior.then(
        () => fn(),
        () => fn(),
      );
      // The NEXT waiter's `prior` must resolve regardless of whether THIS holder's fn() threw —
      // a real advisory lock unlocks unconditionally (its own `finally`). `mine` itself (below)
      // still carries the real outcome back to THIS call's caller.
      mockLockQueue.set(
        qKey,
        mine.catch(() => undefined),
      );
      const value = await mine;
      return { acquired: true, value };
    },
  ),
}));

describe("ReturnsService.create — Idempotency-Key replay guard (REG-RET-IDEM)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let gateway: { emitReturnCreated: jest.Mock };
  let txReturn: { findMany: jest.Mock; create: jest.Mock };
  let store: Map<string, unknown>;
  let idempotency: { check: jest.Mock; save: jest.Mock; keyHash: jest.Mock; hashFor: jest.Mock };

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

  // Mirrors the real IdempotencyService#scopeFor exactly (F6: tenantId is a required positional
  // argument, folded in internally) — kept as one small helper so every fake method (and the
  // assertions below) agree on the same format instead of three hand-typed copies drifting apart.
  const scopeFor = (tenantId: string | null, scopeSuffix: string) =>
    `${tenantId ?? "none"}:${scopeSuffix}`;

  beforeEach(async () => {
    mockLockQueue.clear();
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
      // F6: the exact hash check()/save() use internally, given tenantId as its own argument —
      // this is what returns.service.ts hashes the F5 lock key from.
      hashFor: jest.fn(
        (key: string, tenantId: string | null, scopeSuffix: string) =>
          `${scopeFor(tenantId, scopeSuffix)}:${key}`,
      ),
      check: jest.fn(
        async (key: string, tenantId: string | null, scopeSuffix: string) =>
          store.get(`${scopeFor(tenantId, scopeSuffix)}:${key}`) ?? null,
      ),
      save: jest.fn(
        async (key: string, tenantId: string | null, scopeSuffix: string, response: unknown) => {
          store.set(`${scopeFor(tenantId, scopeSuffix)}:${key}`, response);
        },
      ),
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
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("RET-2026-0001") },
        },
      ],
    }).compile();

    service = mod.get(ReturnsService);
  });

  it("REG-RET-IDEM-1 stores the first result under a tenant + submitter + order scoped key", async () => {
    const first = await service.create(dto(), "user-1", "DRIVER", "key-1");

    expect(txReturn.create).toHaveBeenCalledTimes(1);
    expect(idempotency.save).toHaveBeenCalledTimes(1);
    // F1 (PR-2): tenantId moved to its OWN argument (F6) and the scope suffix now carries the
    // SUBMITTING USER, not the tenant — two different submitters reusing the same client key
    // must never collide (see REG-RET-IDEM-8 below).
    expect(idempotency.save).toHaveBeenCalledWith(
      "key-1",
      "test-tenant",
      "returns.create:user-1:ord-1",
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

  it("REG-RET-IDEM-3 a request with NO Idempotency-Key behaves exactly as before — the guard (and the F5 lock) is never consulted", async () => {
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
      "test-tenant",
      "returns.create:user-1:ord-2",
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

  it("REG-RET-IDEM-6 the SAME payload + key submitted again after the store no longer holds a prior record creates a genuinely SECOND return", async () => {
    // Distinct from REG-RET-IDEM-5's transient-failure fail-open case: this simulates a record
    // that legitimately no longer exists (the 24h window elapsed, an ops purge, or — the
    // reviewed scenario — a driver's mobile nonce rotated after the first attempt landed, so the
    // SERVER-side key this test hand-constructs is the only thing standing in for "no longer
    // cached"). Once the store is reset, there is nothing to replay onto: the guard must not
    // block a genuinely new submission just because the CONTENT matches an old one.
    await service.create(dto(), "user-1", "DRIVER", "key-1");
    expect(txReturn.create).toHaveBeenCalledTimes(1);

    store.clear();
    txReturn.create.mockClear();
    gateway.emitReturnCreated.mockClear();

    await service.create(dto(), "user-1", "DRIVER", "key-1");

    expect(txReturn.create).toHaveBeenCalledTimes(1);
    expect(gateway.emitReturnCreated).toHaveBeenCalledTimes(1);
  });

  it("REG-RET-IDEM-7 F5: two PARALLEL identical submissions race-close to exactly ONE create — the second's check() only runs after the first's save() lands", async () => {
    // Unlike REG-RET-IDEM-2 (sequential — the second call starts only once the first has fully
    // resolved), this fires both requests BEFORE either has completed, exactly like an offline
    // queue drain racing a manual retry, or two devices submitting for the same driver in the
    // same instant. Before F5, check() ran for both BEFORE either had saved, so both created a
    // row; the mocked withAdvisoryLock above is a genuine per-key mutex, so this proves
    // ReturnsService's check→create→save sequence is what gets serialized, not merely that a
    // lock call was made somewhere.
    const [first, second] = await Promise.all([
      service.create(dto(), "user-1", "DRIVER", "key-1"),
      service.create(dto(), "user-1", "DRIVER", "key-1"),
    ]);

    expect(txReturn.create).toHaveBeenCalledTimes(1);
    expect(gateway.emitReturnCreated).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("REG-RET-IDEM-8 F1: the SAME client key under the SAME order but a DIFFERENT submitting user is a different scope and is not collapsed", async () => {
    // Before F1 the scope was tenant+orderId only — two DIFFERENT people (two drivers, or a
    // driver and a customer-portal user) who happened to reuse the same client-generated key for
    // the same order collided onto one submitter's cached result, silently dropping the second
    // person's return.
    await service.create(dto(), "user-1", "DRIVER", "key-1");
    await service.create(dto(), "user-2", "DRIVER", "key-1");

    expect(txReturn.create).toHaveBeenCalledTimes(2);
    expect(idempotency.save).toHaveBeenLastCalledWith(
      "key-1",
      "test-tenant",
      "returns.create:user-2:ord-1",
      expect.anything(),
    );
  });
});
