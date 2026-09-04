/**
 * T3 (R3) — apps/api/src/orders/orders.merge-lock.spec.ts
 *
 * Proves `mergeAllPendingForCustomer` and `forceConsolidateCustomer` take the
 * customer-keyed advisory lock (`common/db-locks.ts`, `withAdvisoryLock`)
 * BEFORE their first `order.findMany` read, and map a `LockTimeoutError` to a
 * 409 `MERGE_IN_PROGRESS` `ConflictException` without ever reaching that read.
 *
 * `common/db-locks.ts` now exists on disk (this PR ships it), so the mock below is an ordinary
 * one — see the note above `jest.mock` for why the original `{ virtual: true }` had to go. No
 * guarded `require` is needed here because nothing in this file imports the real module directly
 * (see test-plan.md T3).
 *
 * The 409/503 mapping asserted here is `orders/merge-contention.ts`'s `mapLockError`, which is
 * the single place a db-locks failure becomes an HTTP error; T3-d additionally pins that the
 * sweep skips by CODE rather than by exception type.
 */

jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

// Shared call-order ledger: the lock mock (below) and the `order.findMany`
// mock (configured per test in beforeEach) both push onto this array, so
// (a)/(b) can assert the lock was taken strictly before the first read —
// exactly the mutation the plan's probe targets ("take the lock after
// order.findMany").
const mockCallOrder: string[] = [];

class MockLockTimeoutError extends Error {
  constructor(
    public readonly family: string,
    public readonly key: string,
    public readonly waitMs: number,
  ) {
    super(`lock timeout: ${family}/${key} after ${waitMs}ms`);
    this.name = "LockTimeoutError";
  }
}

class MockLockUnavailableError extends Error {
  constructor(public readonly cause?: unknown) {
    super("lock unavailable");
    this.name = "LockUnavailableError";
  }
}

const mockWithAdvisoryLock = jest.fn(async (opts: { key: string }, fn: () => Promise<unknown>) => {
  mockCallOrder.push(`lock:${opts.key}`);
  const value = await fn();
  return { acquired: true, value };
});

// NOT `{ virtual: true }` — `../common/db-locks` ships in this PR, so it is an ORDINARY mock.
// The virtual flag was correct only while the module was unwritten, and it is actively harmful
// now: a virtual mock is keyed by the literal `from + moduleName` pair, and jest-resolve's
// module-ID cache is shared by every suite in a worker. With TWO importers under `src/orders/`
// (orders.service.ts and merge-contention.ts) an earlier suite's cache entry for the real module
// won, so `mapLockError` compared against the REAL error classes while the service threw the mock
// ones — four green-in-isolation tests failed only in a full run. Resolving by real path removes
// the ambiguity, and a renamed/deleted module now fails loudly instead of being fabricated.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  LockTimeoutError: MockLockTimeoutError,
  LockUnavailableError: MockLockUnavailableError,
}));

import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { OrdersService } from "./orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";

describe("OrdersService merge paths — customer advisory lock (T3, R3)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    mockCallOrder.length = 0;
    mockWithAdvisoryLock.mockReset();
    mockWithAdvisoryLock.mockImplementation(
      async (opts: { key: string }, fn: () => Promise<unknown>) => {
        mockCallOrder.push(`lock:${opts.key}`);
        const value = await fn();
        return { acquired: true, value };
      },
    );

    prisma = createMockPrisma();
    // Zero pending orders lets both methods short-circuit right after their
    // first read (`pendingOrders.length <= 1` / `orders.length <= 1`) —
    // enough to prove LOCK ORDERING without re-exercising the merge fold's
    // money math, which is covered elsewhere (pricing.spec.ts, the
    // scan-hardening concurrency pin).
    prisma.order.findMany.mockImplementation(async () => {
      mockCallOrder.push("findMany");
      return [];
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken("invoices"), useValue: { add: jest.fn() } },
        { provide: RouteFlowGateway, useValue: { emitOrderStatusChanged: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(0.1) } },
        { provide: InvoicesService, useValue: {} },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: NotificationsService, useValue: {} },
        { provide: InventoryService, useValue: {} },
        {
          provide: AuthorizationGuardService,
          useValue: { assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: PromotionsService,
          useValue: { activeForCatalog: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: MessagingService,
          useValue: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: CreditNotesService,
          useValue: { previewOrderCreditRelease: jest.fn().mockResolvedValue([]) },
        },
        { provide: CommissionEngineService, useValue: {} },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = module.get<OrdersService>(OrdersService);
  });

  describe("T3-a: mergeAllPendingForCustomer takes the advisory lock before its first read", () => {
    it("calls withAdvisoryLock({ family: 'order-merge', key: customerId, mode: 'wait', waitMs: 20000 }) once, strictly before order.findMany", async () => {
      await service.mergeAllPendingForCustomer("cust-9");

      expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
      expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
        expect.objectContaining({
          family: "order-merge",
          key: "cust-9",
          mode: "wait",
          waitMs: 20_000,
        }),
        expect.any(Function),
      );
      // The concrete oracle: the lock ledger entry for this customer must
      // precede the findMany ledger entry — not merely both present.
      expect(mockCallOrder).toEqual(["lock:cust-9", "findMany"]);
    });
  });

  // ─── R1 (round 2): post-commit callers never WAIT on the merge lock ────────
  //
  // A consolidation that runs after its row has committed is deferrable by construction, so it
  // asks for the lock with `try` and defers the moment someone else holds it. Waiting 20 s there
  // would spend a request's remaining budget — and one of the 8 pinned lock-pool slots — on work
  // the hourly sweep does anyway. `wait` stays the default for the sweep/force paths, which have
  // no client attached.
  describe("T3-e: opts.lockMode threads through to withAdvisoryLock", () => {
    it("lockMode 'try' asks for mode 'try'; the default asks for mode 'wait' with waitMs 20000", async () => {
      await service.mergeAllPendingForCustomer("cust-9", {}, { lockMode: "try" });

      expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
      expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
        expect.objectContaining({ family: "order-merge", key: "cust-9", mode: "try" }),
        expect.any(Function),
      );

      // …and the default is unchanged: the sweep/force paths still wait the full 20s.
      mockWithAdvisoryLock.mockClear();
      await service.mergeAllPendingForCustomer("cust-9");
      expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "wait", waitMs: 20_000 }),
        expect.any(Function),
      );
    });

    it("a 'try' that finds the lock held ({ acquired: false }) rejects with the coded 503 and never reads orders", async () => {
      mockWithAdvisoryLock.mockResolvedValueOnce({ acquired: false } as any);

      let caught: unknown;
      try {
        await service.mergeAllPendingForCustomer("cust-9", {}, { lockMode: "try" });
      } catch (err) {
        caught = err;
      }

      // The coded 503 is what every post-commit caller's `isMergeContention` swallow turns into
      // "deferred" — so not-acquired must never resolve as a successful (no-op) merge.
      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      expect((caught as ServiceUnavailableException | undefined)?.getResponse()).toEqual(
        expect.objectContaining({ code: "LOCK_UNAVAILABLE" }),
      );
      expect(prisma.order.findMany).not.toHaveBeenCalled();
    });
  });

  describe("T3-b: forceConsolidateCustomer takes the advisory lock before its first read", () => {
    it("calls withAdvisoryLock({ family: 'order-merge', key: customerId, mode: 'wait', waitMs: 20000 }) once, strictly before order.findMany", async () => {
      await service.forceConsolidateCustomer("cust-9");

      expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
      expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
        expect.objectContaining({
          family: "order-merge",
          key: "cust-9",
          mode: "wait",
          waitMs: 20_000,
        }),
        expect.any(Function),
      );
      expect(mockCallOrder).toEqual(["lock:cust-9", "findMany"]);
    });
  });

  describe("T3-c: a LockTimeoutError maps to 409 MERGE_IN_PROGRESS, never reaching order.findMany", () => {
    it("mergeAllPendingForCustomer rejects with ConflictException { code: 'MERGE_IN_PROGRESS' } and order.findMany is never called", async () => {
      mockWithAdvisoryLock.mockRejectedValueOnce(
        new MockLockTimeoutError("order-merge", "cust-9", 20_000),
      );

      let caught: unknown;
      try {
        await service.mergeAllPendingForCustomer("cust-9");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      expect((caught as ConflictException | undefined)?.getResponse()).toEqual(
        expect.objectContaining({ code: "MERGE_IN_PROGRESS" }),
      );
      expect(prisma.order.findMany).not.toHaveBeenCalled();
    });

    it("forceConsolidateCustomer rejects with ConflictException { code: 'MERGE_IN_PROGRESS' } and order.findMany is never called", async () => {
      mockWithAdvisoryLock.mockRejectedValueOnce(
        new MockLockTimeoutError("order-merge", "cust-9", 20_000),
      );

      let caught: unknown;
      try {
        await service.forceConsolidateCustomer("cust-9");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      expect((caught as ConflictException | undefined)?.getResponse()).toEqual(
        expect.objectContaining({ code: "MERGE_IN_PROGRESS" }),
      );
      expect(prisma.order.findMany).not.toHaveBeenCalled();
    });
  });

  describe("T3-d: sweepAllPendingOrders survives a contended customer", () => {
    it("skips a customer whose merge throws ConflictException, still merges the rest, and warns", async () => {
      prisma.order.groupBy.mockResolvedValue([
        { customerId: "cust-A" },
        { customerId: "cust-B" },
      ] as any);
      const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
      jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
      const merge = jest
        .spyOn(service, "mergeAllPendingForCustomer")
        .mockImplementation(async (customerId: string) => {
          if (customerId === "cust-A") {
            throw new ConflictException({
              code: "MERGE_IN_PROGRESS",
              message: "Another merge for this customer is in progress — retry.",
            });
          }
          return { id: "winner-B" } as any;
        });

      const result = await service.sweepAllPendingOrders();

      expect(merge).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ customers: 2, merged: 1 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("cust-A"));
    });

    it("still propagates a non-lock error from a customer's merge", async () => {
      prisma.order.groupBy.mockResolvedValue([{ customerId: "cust-A" }] as any);
      jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
      jest.spyOn(service, "mergeAllPendingForCustomer").mockRejectedValue(new Error("boom"));

      await expect(service.sweepAllPendingOrders()).rejects.toThrow("boom");
    });

    it("skips a customer whose merge throws the coded 503 (LOCK_UNAVAILABLE) and continues to the next", async () => {
      prisma.order.groupBy.mockResolvedValue([
        { customerId: "cust-A" },
        { customerId: "cust-B" },
      ] as any);
      const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
      jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
      const merge = jest
        .spyOn(service, "mergeAllPendingForCustomer")
        .mockImplementation(async (customerId: string) => {
          if (customerId === "cust-A") {
            throw new ServiceUnavailableException({
              code: "LOCK_UNAVAILABLE",
              message: "Order merge lock unavailable — retry shortly.",
            });
          }
          return { id: "winner-B" } as any;
        });

      const result = await service.sweepAllPendingOrders();

      // An exhausted lock pool is contention too: skip that customer this hour and
      // keep sweeping, rather than abandoning every customer after the first.
      expect(merge).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ customers: 2, merged: 1 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("cust-A"));
    });

    it("does NOT swallow a 503 raised for some other reason — the skip is by CODE, not by exception type", async () => {
      prisma.order.groupBy.mockResolvedValue([
        { customerId: "cust-A" },
        { customerId: "cust-B" },
      ] as any);
      jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
      const merge = jest
        .spyOn(service, "mergeAllPendingForCustomer")
        .mockRejectedValue(new ServiceUnavailableException("upstream pricing service is down"));

      // Behaviour CHANGE from the type-based skip this replaced: an uncoded 503 (or an
      // uncoded 409) used to be swallowed as contention, so a genuinely broken merge
      // showed up only as an hourly "skipped" line and never as a failure. It now stops
      // the sweep on the first customer.
      await expect(service.sweepAllPendingOrders()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(merge).toHaveBeenCalledTimes(1);
    });
  });
});
