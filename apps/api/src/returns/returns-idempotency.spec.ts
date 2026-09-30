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
 * the scope is tenant- AND submitter-specific (F1, PR-2), a request with NO
 * header behaves exactly as it did before this change, the check-then-act
 * race between two concurrent IDENTICAL submissions is closed (F5 round 2 /
 * N1's transaction-scoped lock), DIFFERENT keys never serialize against each
 * other (N1), a genuinely later submission (a different key, or the store no
 * longer holding a prior record) still creates a new return, and a retry
 * whose order state has since changed still returns the saved body instead
 * of a 404/400 (round 3).
 *
 * STRUCTURAL NOTE (F5 round 2 / N1, then round 3, 2026-09-15): round 1 ran check() BEFORE the
 * order lookup and BEFORE opening any transaction, so a replay never touched the database at
 * all. Round 2 (N1) moved check+create+save INSIDE the create() transaction (alongside a
 * transaction-scoped pg_advisory_xact_lock, replacing round 1's dedicated connection pool) but
 * put the order lookup BEFORE the check, inside the transaction — meaning a replay DID still run
 * order/DELIVERED/ownership validation, which could wrongly 404/400 a retry whose order state
 * had moved on since the original (already-successful) attempt. Round 3 fixed the ordering:
 * check runs FIRST; order lookup/validation run only on a genuine miss. A replay therefore now
 * calls NEITHER `prisma.order.findUnique` NOR `tx.return.create` — it still opens a transaction
 * (for the lock+check), but never reaches order validation or a second write.
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

describe("ReturnsService.create — Idempotency-Key replay guard (REG-RET-IDEM)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let gateway: { emitReturnCreated: jest.Mock };
  let txReturn: { findMany: jest.Mock; create: jest.Mock };
  let store: Map<string, unknown>;
  let idempotency: {
    check: jest.Mock;
    save: jest.Mock;
    keyHash: jest.Mock;
    hashFor: jest.Mock;
    acquireLock: jest.Mock;
  };
  // F5 round 2 (N1): a genuine per-hash mutex — NOT a passthrough — so REG-RET-IDEM-7 below can
  // prove the check-then-act race is actually closed. `acquireLock` claims a place in the queue
  // for its hash; `check` (on a cache HIT) and `save` are the two points the REAL
  // transaction-scoped xact lock would actually let go (the transaction returns early, or is
  // about to commit for real) — both release here too. A DIFFERENT hash never touches this
  // queue at all, which is exactly what REG-RET-IDEM-9 (8 parallel distinct keys) relies on.
  let mockLockQueue: Map<string, Promise<void>>;
  let mockLockRelease: Map<string, () => void>;

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
  const storeKey = (key: string, tenantId: string | null, scopeSuffix: string) =>
    `${scopeFor(tenantId, scopeSuffix)}:${key}`;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.order.findUnique.mockResolvedValue(order as any);

    txReturn = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: "ret-1", returnNumber: "RET-2026-1", items: [] }),
    };
    // Round 3 (independent review round 3, PR-2): order lookup + role check now run on `tx`
    // (inside the transaction, after the replay check) — `order`/`customer` reuse the SAME mock
    // refs as the top-level `prisma` object, so a test's `prisma.order.findUnique.mockResolvedValue(...)`
    // is exactly what `tx.order.findUnique` sees too.
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      fn({
        return: txReturn,
        // PR-1a: the shared prior-returned reader (returnedPiecesByProduct) also queries
        // returnItem for INLINE-kind rows sourced from this order — always empty here, no
        // INLINE return exists in this suite.
        returnItem: { findMany: jest.fn().mockResolvedValue([]) },
        order: prisma.order,
        customer: prisma.customer,
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn(),
      }),
    );

    // A real in-memory stand-in rather than a bare jest.fn, so the SECOND call
    // genuinely reads back what the first stored — under the same scoping rule
    // the production service uses.
    store = new Map<string, unknown>();
    mockLockQueue = new Map<string, Promise<void>>();
    mockLockRelease = new Map<string, () => void>();

    const release = (hash: string) => {
      mockLockRelease.get(hash)?.();
      mockLockRelease.delete(hash);
    };

    idempotency = {
      keyHash: jest.fn((key: string, scope: string) => `${scope}:${key}`),
      // F6: the exact hash check()/save() use internally, given tenantId as its own argument —
      // this is what returns.service.ts hashes the F5-round-2 lock key from.
      hashFor: jest.fn((key: string, tenantId: string | null, scopeSuffix: string) =>
        storeKey(key, tenantId, scopeSuffix),
      ),
      acquireLock: jest.fn(async (hash: string) => {
        const prior = mockLockQueue.get(hash) ?? Promise.resolve();
        let releaseFn!: () => void;
        const mine = new Promise<void>((res) => {
          releaseFn = res;
        });
        mockLockQueue.set(hash, mine);
        await prior; // wait for whoever held this hash before us, if anyone
        // PR-1a §5: create() also takes a customer-scoped lock (`returns.customer`) that is
        // held for the REST of the transaction in production (a real pg_advisory_xact_lock,
        // auto-released at commit) — this suite's mutex-holding release points (check()/save(),
        // below) exist only to test the KEY-scoped lock's exclusion (REG-RET-IDEM-7/9), so the
        // customer lock releases itself immediately here rather than being held across an
        // entire create() call with no matching release hook — every test in this file reuses
        // the SAME customerId, and holding it forever would deadlock every second call.
        if (hash.includes(":returns.customer:")) {
          releaseFn();
          mockLockQueue.delete(hash);
          return;
        }
        mockLockRelease.set(hash, releaseFn);
      }),
      check: jest.fn(async (key: string, tenantId: string | null, scopeSuffix: string) => {
        const hash = storeKey(key, tenantId, scopeSuffix);
        const cached = store.get(hash) ?? null;
        // A cache HIT is where the real transaction would return early — release now, not at
        // some later save() that will never come for this attempt.
        if (cached) release(hash);
        return cached;
      }),
      save: jest.fn(
        async (key: string, tenantId: string | null, scopeSuffix: string, response: unknown) => {
          const hash = storeKey(key, tenantId, scopeSuffix);
          store.set(hash, response);
          release(hash);
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
      expect.anything(), // tx (F5 round 2 / N1 — save() now runs on the create's own transaction)
    );
    expect(gateway.emitReturnCreated).toHaveBeenCalledTimes(1);
  });

  it("REG-RET-IDEM-2 a REPLAY with the same key creates nothing, re-emits nothing, and never even reaches order validation (round 3 — see the file header)", async () => {
    const first = await service.create(dto(), "user-1", "DRIVER", "key-1");

    txReturn.create.mockClear();
    prisma.tenantTransaction.mockClear();
    gateway.emitReturnCreated.mockClear();
    prisma.order.findUnique.mockClear();

    const replay = await service.create(dto(), "user-1", "DRIVER", "key-1");

    expect(replay).toBe(first);
    // No second row.
    expect(txReturn.create).not.toHaveBeenCalled();
    // A second return.created would light up the operator dashboard twice.
    expect(gateway.emitReturnCreated).not.toHaveBeenCalled();
    // Round 3: the replay check now runs BEFORE order lookup/validation, so a cache hit returns
    // before ever reaching it — a retry must never 404/400 on order state that moved on since
    // the original (already-successful) attempt. The transaction still opens (for the lock+check).
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });

  it("round 3 (independent review round 3, PR-2): a retry whose order state now FAILS validation still returns the FIRST saved return, never a 404/400", async () => {
    // The exact scenario the ruling names: the first create() succeeds while the order is
    // DELIVERED; something else changes the order's state afterward (unrelated to this return);
    // a retry with the SAME key must still get the saved body — proving the replay check truly
    // runs before, not just structurally near, the order/DELIVERED/ownership checks.
    const first = await service.create(dto(), "user-1", "DRIVER", "key-1");
    expect(txReturn.create).toHaveBeenCalledTimes(1);

    txReturn.create.mockClear();
    gateway.emitReturnCreated.mockClear();
    prisma.order.findUnique.mockClear();
    // The order's state has moved on — a fresh lookup would now throw. If the replay check
    // did not run first, this retry would 400 instead of returning the saved return.
    prisma.order.findUnique.mockResolvedValue({ ...order, status: "CANCELLED" } as any);

    const retry = await service.create(dto(), "user-1", "DRIVER", "key-1");

    expect(retry).toBe(first);
    expect(txReturn.create).not.toHaveBeenCalled();
    expect(gateway.emitReturnCreated).not.toHaveBeenCalled();
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it("REG-RET-IDEM-3 a request with NO Idempotency-Key behaves exactly as before on the KEY guard — check/save are never consulted (the PR-1a customer lock, §5, is unconditional and still fires)", async () => {
    await service.create(dto(), "user-1", "DRIVER");

    expect(idempotency.check).not.toHaveBeenCalled();
    expect(idempotency.save).not.toHaveBeenCalled();
    // PR-1a §5: the customer-keyed lock in create() is unconditional (not gated on an
    // Idempotency-Key header) — it always fires once per create(), unlike the key-scoped
    // lock/check/save trio above.
    expect(idempotency.acquireLock).toHaveBeenCalledTimes(1);
    expect(idempotency.acquireLock).toHaveBeenCalledWith(
      storeKey("cust-1", "test-tenant", "returns.customer"),
      expect.anything(),
    );
    expect(txReturn.create).toHaveBeenCalledTimes(1);
    expect(gateway.emitReturnCreated).toHaveBeenCalledTimes(1);

    // And two key-less submissions both land, exactly as today: two genuinely
    // separate partial returns on one order is a real workflow.
    await service.create(dto(), "user-1", "DRIVER");
    expect(txReturn.create).toHaveBeenCalledTimes(2);
    expect(idempotency.acquireLock).toHaveBeenCalledTimes(2);
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
      expect.anything(), // tx
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
    // that legitimately no longer exists (the 24h window elapsed, an ops purge). Once the store
    // is reset, there is nothing to replay onto: the guard must not block a genuinely new
    // submission just because the CONTENT matches an old one.
    await service.create(dto(), "user-1", "DRIVER", "key-1");
    expect(txReturn.create).toHaveBeenCalledTimes(1);

    store.clear();
    txReturn.create.mockClear();
    gateway.emitReturnCreated.mockClear();

    await service.create(dto(), "user-1", "DRIVER", "key-1");

    expect(txReturn.create).toHaveBeenCalledTimes(1);
    expect(gateway.emitReturnCreated).toHaveBeenCalledTimes(1);
  });

  it("REG-RET-IDEM-7 F5 round 2 (N1): two PARALLEL identical submissions (SAME key) race-close to exactly ONE create — the second's check() only runs after the first's save() lands", async () => {
    // Unlike REG-RET-IDEM-2 (sequential — the second call starts only once the first has fully
    // resolved), this fires both requests BEFORE either has completed, exactly like an offline
    // queue drain racing a manual retry, or two devices submitting for the same driver in the
    // same instant. The mocked acquireLock/check/save above form a genuine per-hash mutex, so
    // this proves ReturnsService's acquireLock→check→create→save sequence is what gets
    // serialized now that it lives inside the transaction, not merely that acquireLock was
    // called somewhere.
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
      expect.anything(), // tx
    );
  });

  it("REG-RET-IDEM-9 N1: 8 PARALLEL submissions for one order, each with a DISTINCT key, all succeed — different KEYS never serialize against each other (PR-1a: they now also share one CUSTOMER lock — see returns-customer-lock.spec.ts for that mutex's own proof)", async () => {
    // Proves the flip side of REG-RET-IDEM-7: the lock is keyed on the hash, so unrelated keys
    // must never queue behind one another the way two identical-key attempts correctly do. Round
    // 1's dedicated 6-connection pool could in principle starve under enough concurrent DIFFERENT
    // keys; round 2's transaction-scoped lock has no pool to starve at all.
    const keys = Array.from({ length: 8 }, (_, i) => `key-${i}`);

    await Promise.all(keys.map((key) => service.create(dto(), "user-1", "DRIVER", key)));

    // All 8 landed — none silently collapsed onto another, and none blocked behind a DIFFERENT
    // key's holder. `acquireLock` was called once per key (never re-queued behind an unrelated
    // hash), and every attempt reached its own `save()`. PR-1a §5 adds a SECOND acquireLock per
    // create() — the customer-keyed lock — which is the SAME hash for all 8 (one order, one
    // customer): 8 distinct key-hash locks + 1 shared customer-hash lock = 16 calls, 9 unique
    // hashes. The 8 key-scoped locks still never queue behind each other or the shared one in a
    // way that blocks completion — this suite has no assertion on ORDER, only on outcome.
    expect(txReturn.create).toHaveBeenCalledTimes(8);
    expect(gateway.emitReturnCreated).toHaveBeenCalledTimes(8);
    expect(idempotency.acquireLock).toHaveBeenCalledTimes(16);
    expect(idempotency.save).toHaveBeenCalledTimes(8);
    const lockedHashes = idempotency.acquireLock.mock.calls.map((c: unknown[]) => c[0]);
    expect(new Set(lockedHashes).size).toBe(9);
  });

  it("REG-RET-IDEM-10 N5: the SAME payload submitted under two DIFFERENT keys creates TWO returns — content alone is never the identity, the key is", async () => {
    // The server-side counterpart to the mobile nonce scenario (return-submit-key.test.ts's
    // end-to-end case): a driver returns 2 units, then genuinely finds 2 more of the same
    // product later — the mobile client mints a fresh nonce (a fresh key) for that second
    // attempt. Two distinct keys for byte-identical content must never be collapsed.
    const payload = dto();
    txReturn.create
      .mockResolvedValueOnce({ id: "ret-a", returnNumber: "RET-2026-A", items: [] })
      .mockResolvedValueOnce({ id: "ret-b", returnNumber: "RET-2026-B", items: [] });

    const first = await service.create(payload, "user-1", "DRIVER", "key-a");
    const second = await service.create(payload, "user-1", "DRIVER", "key-b");

    expect(txReturn.create).toHaveBeenCalledTimes(2);
    expect(second.id).not.toBe(first.id);
    expect(gateway.emitReturnCreated).toHaveBeenCalledTimes(2);
  });
});
