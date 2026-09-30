/**
 * PR-1a §5 fix-round (Opus review condition 4's revert probe): proves the
 * customer-keyed lock in `create()` actually serializes concurrent requests for
 * the same customer, held for the whole transaction — not just that
 * `acquireLock` was called with the right hash.
 *
 * `returns-idempotency.spec.ts`'s shared mock deliberately releases the
 * `returns.customer` hash immediately (documented there: holding it with no
 * matching release hook would deadlock every one of its sequential tests,
 * which all reuse one customerId). This file uses its own mock, scoped to
 * exactly this property, that holds the lock until the surrounding
 * `tenantTransaction` callback resolves — mirroring the REAL primitive (a
 * `pg_advisory_xact_lock`, released at commit).
 *
 * No INLINE-kind row can be created yet (its endpoints ship in PR-1c/1d), so
 * the closest faithful proxy for "a concurrent STANDARD/INLINE pair" is two
 * concurrent STANDARD `create()` calls for the same customer on two different
 * orders — the lock is customer-scoped, not order-scoped, so this exercises
 * the same mutex an INLINE capture will later share.
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

describe("ReturnsService.create — customer lock mutual exclusion (§5 fix-round)", () => {
  it("a SECOND create() for the same customer waits for the FIRST's transaction to finish, even on a DIFFERENT order", async () => {
    const prisma = createMockPrisma();
    const order = (id: string) => ({
      id,
      status: "DELIVERED",
      customerId: "cust-shared",
      customer: { id: "cust-shared", businessName: "Acme Co" },
      lineItems: [{ productId: "p1", qty: 10, unitPrice: 5, status: "PENDING", subtotal: 50 }],
      invoices: [],
    });
    prisma.order.findUnique.mockImplementation(async ({ where }: any) => order(where.id));

    // A genuine per-hash mutex for the customer-scoped lock only — held until the
    // enclosing tenantTransaction's callback resolves (the real commit-time release).
    // Queue-then-wait lives INSIDE acquireLock (the caller of `await prior` and the
    // holder of the NEXT waiter's promise must be the same call); release is a
    // separate signal the tenantTransaction wrapper fires once `fn(tx)` settles —
    // same split as returns-idempotency.spec.ts's proven acquireLock mock.
    const customerLockQueue = new Map<string, Promise<void>>();
    const customerLockRelease = new Map<string, () => void>();
    const events: string[] = [];

    const idempotency = {
      hashFor: jest.fn(
        (key: string, tenantId: string | null, scopeSuffix: string) =>
          `${tenantId}:${scopeSuffix}:${key}`,
      ),
      acquireLock: jest.fn(async (hash: string) => {
        if (!hash.includes(":returns.customer:")) return; // key-scoped lock: irrelevant here, no header used
        const prior = customerLockQueue.get(hash) ?? Promise.resolve();
        let releaseFn!: () => void;
        const mine = new Promise<void>((res) => {
          releaseFn = res;
        });
        customerLockQueue.set(hash, mine);
        events.push(`wait:${hash}`);
        await prior;
        events.push(`held:${hash}`);
        customerLockRelease.set(hash, releaseFn);
      }),
      check: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue(undefined),
    };

    let txCounter = 0;
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      const txId = ++txCounter;
      const txReturn = {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(async () => {
          events.push(`create:${txId}`);
          return { id: `ret-${txId}`, items: [] };
        }),
      };
      const tx = {
        return: txReturn,
        returnItem: { findMany: jest.fn().mockResolvedValue([]) },
        order: prisma.order,
        customer: prisma.customer,
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn(),
      };
      const hash = "test-tenant:returns.customer:cust-shared";
      try {
        return await fn(tx);
      } finally {
        // Release the customer-hash lock only once THIS transaction's work is done —
        // the real primitive releases at commit, not at any earlier point.
        events.push(`release:${hash}:${txId}`);
        customerLockRelease.get(hash)?.();
        customerLockRelease.delete(hash);
      }
    });

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: CreditNotesService, useValue: {} },
        { provide: IdempotencyService, useValue: idempotency },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("RET-1") },
        },
      ],
    }).compile();
    const service = mod.get(ReturnsService);

    const [first, second] = await Promise.all([
      service.create(
        { orderId: "ord-a", reason: "DAMAGED", items: [{ productId: "p1", qty: 1 }] },
        "user-1",
      ),
      service.create(
        { orderId: "ord-b", reason: "DAMAGED", items: [{ productId: "p1", qty: 1 }] },
        "user-1",
      ),
    ]);

    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // The second attempt's lock is genuinely HELD until the first transaction's own
    // release fires — if the customer lock were a no-op, both "wait" events would be
    // followed immediately by "held" with no interleaved "create"/"release" from the
    // other attempt.
    const heldIndices = events
      .map((e, i) => (e.startsWith("held:") ? i : -1))
      .filter((i) => i >= 0);
    expect(heldIndices).toHaveLength(2);
    // Between the two "held" events, the FIRST transaction must have created its row
    // and released its lock — proving the second attempt was genuinely blocked, not
    // just called in some arbitrary order.
    const between = events.slice(heldIndices[0] + 1, heldIndices[1]);
    expect(between.some((e) => e.startsWith("create:"))).toBe(true);
    expect(between.some((e) => e.startsWith("release:"))).toBe(true);
  });
});
