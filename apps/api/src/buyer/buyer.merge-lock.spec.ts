/**
 * IMP-02 (R2 companion) — `BuyerController.createOrder`'s merge branch takes the
 * customer-keyed advisory lock.
 *
 * `POST /buyer/orders` runs the SAME read-fold-absolute-write critical section as
 * the staff merge, over the SAME rows: findActiveOrder → foldMergeItems →
 * updateOrderItems({ replaceAll: true }). It never had even the in-process Map the
 * staff controller carried, so a staff merge committing between the buyer's read
 * and its write was silently overwritten. This suite pins:
 *   - the fold+write runs INSIDE `withAdvisoryLock` on `{family:"order-merge",
 *     key: ctx.customerId, mode:"wait", waitMs:10_000}` — the same (family, key)
 *     the staff path and `OrdersService`'s sweeps use, so they serialize;
 *   - the sibling sweep (`mergeAllPendingForCustomer`) and the response read run
 *     AFTER the lock is released. That call takes this very (family, key) itself,
 *     on a DIFFERENT pooled connection, so nesting it would block until
 *     lock_timeout and 409 every buyer merge;
 *   - the error mapping: 55P03 → 409 MERGE_IN_PROGRESS, connect failure → 503.
 *
 * `../common/db-locks` exists on disk, so this is an ordinary — NOT `virtual` —
 * mock: renaming or deleting the real module makes this suite fail loudly instead
 * of Jest fabricating a stand-in. Module setup copied from
 * `./buyer.controller.merge.spec.ts`.
 */

// Shared ledger: the lock mock and the OrdersService mocks push onto it, so the
// tests can assert what ran inside the critical section and what ran after it.
const mockCallOrder: string[] = [];

jest.mock("../common/db-locks", () => {
  class LockTimeoutError extends Error {
    constructor(
      public readonly family: string,
      public readonly key: string,
      public readonly waitMs: number,
    ) {
      super(`advisory lock timeout: ${family}:${key} after ${waitMs}ms`);
      this.name = "LockTimeoutError";
    }
  }
  class LockUnavailableError extends Error {
    constructor(public readonly cause?: unknown) {
      super("advisory lock unavailable");
      this.name = "LockUnavailableError";
    }
  }
  const withAdvisoryLock = jest.fn(
    async (
      opts: { family: string; key: string; mode: "wait" | "try"; waitMs?: number },
      fn: () => Promise<unknown>,
    ) => {
      mockCallOrder.push(`lock:enter:${opts.family}:${opts.key}`);
      try {
        return { acquired: true, value: await fn() };
      } finally {
        mockCallOrder.push("lock:exit");
      }
    },
  );
  return { withAdvisoryLock, LockTimeoutError, LockUnavailableError };
});

/** Reaches the mocked module through the registry so a rename fails loudly. */
function requireDbLocksMock(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../common/db-locks");
}

import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { BuyerController } from "./buyer.controller";
import { BuyerService } from "./buyer.service";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { ReplenishmentService } from "./replenishment.service";
import { ShelfService } from "./shelf.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { PromotionsService } from "../promotions/promotions.service";
import { OrdersService } from "../orders/orders.service";
import { ChangeRequestsService } from "../orders/change-requests.service";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { StatementService } from "./statement.service";
import { StatementPdfService } from "./statement-pdf.service";
import { CustomersService } from "../customers/customers.service";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { AuthorizationsService } from "../authorizations/authorizations.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { createMockPrisma } from "../testing/prisma-mock";

const MOCK_CTX = {
  customerId: "cust-lock-1",
  tenantId: "tenant-xyz",
  tenantSlug: "acme",
  userId: null,
  customer: { id: "cust-lock-1", businessName: "Lock Test Buyer" },
};

const ACTIVE_ORDER = {
  id: "order-active-lock",
  customerId: MOCK_CTX.customerId,
  lineItems: [
    { id: "li-1", productId: "prod-a", qty: 2, boxes: null, pieces: null, unitPrice: 10 },
  ],
};

describe("BuyerController.createOrder — customer advisory lock (IMP-02 / R2 companion)", () => {
  let controller: BuyerController;
  let ordersService: {
    findActiveOrder: jest.Mock;
    updateOrderItems: jest.Mock;
    applyBuyerMergeHeader: jest.Mock;
    mergeAllPendingForCustomer: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
  };
  let prisma: ReturnType<typeof createMockPrisma>;
  let locks: {
    withAdvisoryLock: jest.Mock;
    LockTimeoutError: new (family: string, key: string, waitMs: number) => Error;
    LockUnavailableError: new (cause?: unknown) => Error;
  };

  beforeEach(async () => {
    mockCallOrder.length = 0;
    locks = requireDbLocksMock();
    locks.withAdvisoryLock.mockClear();

    ordersService = {
      findActiveOrder: jest.fn().mockResolvedValue(ACTIVE_ORDER),
      updateOrderItems: jest.fn(async () => {
        mockCallOrder.push("updateOrderItems");
      }),
      applyBuyerMergeHeader: jest.fn(async () => {
        mockCallOrder.push("applyBuyerMergeHeader");
      }),
      mergeAllPendingForCustomer: jest.fn(async () => {
        mockCallOrder.push("mergeAllPendingForCustomer");
        return null;
      }),
      create: jest.fn(async () => {
        mockCallOrder.push("create");
        return { id: "order-fresh" };
      }),
      findOne: jest.fn(async () => {
        mockCallOrder.push("findOne");
        return { id: "order-merged" };
      }),
    };
    prisma = createMockPrisma();
    prisma.forTenant().product.findMany.mockResolvedValue([{ id: "prod-a", unitsPerBox: 1 }]);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuyerController],
      providers: [
        { provide: BuyerService, useValue: {} },
        { provide: BuyerCatalogService, useValue: {} },
        { provide: BuyerDashboardService, useValue: {} },
        { provide: ReplenishmentService, useValue: {} },
        { provide: ShelfService, useValue: {} },
        { provide: StockAlertService, useValue: {} },
        { provide: PromotionsService, useValue: {} },
        { provide: OrdersService, useValue: ordersService },
        { provide: ChangeRequestsService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
        { provide: InvoicePdfService, useValue: {} },
        { provide: StatementService, useValue: {} },
        { provide: StatementPdfService, useValue: {} },
        { provide: CustomersService, useValue: {} },
        { provide: OrderTemplatesService, useValue: {} },
        { provide: AuthorizationsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: {} },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((id, fn) => fn()), getOrNull: jest.fn().mockReturnValue(null) },
        },
      ],
    }).compile();

    controller = module.get<BuyerController>(BuyerController);
  });

  it("folds and writes INSIDE withAdvisoryLock on {order-merge, customerId, wait, 10000} — the same key the staff merge uses", async () => {
    const dto = { items: [{ productId: "prod-a", qty: 3 }] };

    await controller.createOrder(dto as any, MOCK_CTX as any);

    expect(locks.withAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(locks.withAdvisoryLock.mock.calls[0][0]).toEqual({
      family: "order-merge",
      key: MOCK_CTX.customerId,
      mode: "wait",
      waitMs: 10_000,
    });
    // The absolute-total write is what the lock exists to serialize.
    expect(mockCallOrder.indexOf("updateOrderItems")).toBeGreaterThan(
      mockCallOrder.indexOf(`lock:enter:order-merge:${MOCK_CTX.customerId}`),
    );
    expect(mockCallOrder.indexOf("updateOrderItems")).toBeLessThan(
      mockCallOrder.indexOf("lock:exit"),
    );
    expect(ordersService.updateOrderItems).toHaveBeenCalledWith(
      ACTIVE_ORDER.id,
      expect.objectContaining({ replaceAll: true }),
      expect.any(Object),
    );
  });

  it("runs the sibling sweep and the response read AFTER the lock is released — mergeAllPendingForCustomer takes the SAME key and would self-block if nested", async () => {
    const dto = { items: [{ productId: "prod-a", qty: 3 }] };

    const result = await controller.createOrder(dto as any, MOCK_CTX as any);

    expect(mockCallOrder).toEqual([
      `lock:enter:order-merge:${MOCK_CTX.customerId}`,
      "updateOrderItems",
      "applyBuyerMergeHeader",
      "lock:exit",
      "mergeAllPendingForCustomer",
      "findOne",
    ]);
    // Still the merged order that comes back, read by id after the sweep.
    expect(ordersService.findOne).toHaveBeenCalledWith(ACTIVE_ORDER.id, expect.any(Object));
    expect(result).toEqual({ id: "order-merged" });
  });

  it("maps a LockTimeoutError to 409 MERGE_IN_PROGRESS and never writes items", async () => {
    locks.withAdvisoryLock.mockImplementationOnce(async () => {
      throw new locks.LockTimeoutError("order-merge", MOCK_CTX.customerId, 20_000);
    });
    const dto = { items: [{ productId: "prod-a", qty: 3 }] };

    await expect(controller.createOrder(dto as any, MOCK_CTX as any)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(ordersService.updateOrderItems).not.toHaveBeenCalled();
    expect(ordersService.create).not.toHaveBeenCalled();
  });

  it("the 409 body carries code MERGE_IN_PROGRESS", async () => {
    locks.withAdvisoryLock.mockImplementationOnce(async () => {
      throw new locks.LockTimeoutError("order-merge", MOCK_CTX.customerId, 20_000);
    });
    const dto = { items: [{ productId: "prod-a", qty: 3 }] };

    await expect(controller.createOrder(dto as any, MOCK_CTX as any)).rejects.toMatchObject({
      response: { code: "MERGE_IN_PROGRESS" },
    });
  });

  it("maps a LockUnavailableError to 503 rather than falling through to an unlocked merge", async () => {
    locks.withAdvisoryLock.mockImplementationOnce(async () => {
      throw new locks.LockUnavailableError(new Error("ECONNREFUSED"));
    });
    const dto = { items: [{ productId: "prod-a", qty: 3 }] };

    await expect(controller.createOrder(dto as any, MOCK_CTX as any)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(ordersService.updateOrderItems).not.toHaveBeenCalled();
    expect(ordersService.create).not.toHaveBeenCalled();
  });

  it("rethrows a merge failure untouched — only lock errors are remapped", async () => {
    const boom = new Error("updateOrderItems blew up");
    ordersService.updateOrderItems.mockRejectedValueOnce(boom);
    const dto = { items: [{ productId: "prod-a", qty: 3 }] };

    await expect(controller.createOrder(dto as any, MOCK_CTX as any)).rejects.toBe(boom);
  });

  it("no active order: the lock is still taken, and the create-new path runs unchanged after it", async () => {
    ordersService.findActiveOrder.mockResolvedValue(null);
    const dto = { items: [{ productId: "prod-a", qty: 3 }] };

    const result = await controller.createOrder(dto as any, MOCK_CTX as any);

    expect(locks.withAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(ordersService.updateOrderItems).not.toHaveBeenCalled();
    expect(ordersService.create).toHaveBeenCalledTimes(1);
    expect(mockCallOrder).toEqual([
      `lock:enter:order-merge:${MOCK_CTX.customerId}`,
      "lock:exit",
      "create",
      "mergeAllPendingForCustomer",
    ]);
    expect(result).toEqual({ id: "order-fresh" });
  });

  // ─── R1 / R4 (round 2) ────────────────────────────────────────────────────
  //
  // R1: both consolidations on this endpoint run POST-COMMIT (the fold inside the lock, or
  // `create`), so they ask for the customer's lock with `try` and defer the instant someone else
  // holds it — waiting 20s there would burn the buyer's request budget on work the hourly sweep
  // does anyway. The `{ acquired: false }` that `try` returns surfaces from the service as the
  // coded 503, which is exactly what these swallows recognise.
  //
  // R4: on the PRE-commit lock, however, a not-acquired result must NOT collapse into `null` —
  // that is the same value "no active order" produces, and it would fall through to create() and
  // hand the buyer a SECOND order for a merge that never ran.

  const lockUnavailable = () =>
    new ServiceUnavailableException({
      code: "LOCK_UNAVAILABLE",
      message: "Order merge lock unavailable — retry shortly.",
    });
  const dtoOf = () => ({ items: [{ productId: "prod-a", qty: 3 }] });

  it("R1: the sibling sweep is called with { lockMode: 'try' } and, when it defers with the coded 503, the merged order still comes back — one warning, no error", async () => {
    ordersService.mergeAllPendingForCustomer.mockRejectedValueOnce(lockUnavailable());
    const warn = jest.spyOn((controller as any).logger, "warn").mockImplementation(() => undefined);

    const result = await controller.createOrder(dtoOf() as any, MOCK_CTX as any);

    // The fold has COMMITTED and the buyer's cart clears on success: an error here would send
    // them back to a cart they already submitted, and the fold is ABSOLUTE, so re-submitting
    // doubles the order.
    expect(result).toEqual({ id: "order-merged" });
    expect(ordersService.mergeAllPendingForCustomer).toHaveBeenCalledWith(
      MOCK_CTX.customerId,
      { buyerInitiated: true },
      { lockMode: "try" },
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("R1: a NON-contention failure from the sibling sweep still propagates — the swallow is by CODE", async () => {
    ordersService.mergeAllPendingForCustomer.mockRejectedValueOnce(new Error("db down"));
    jest.spyOn((controller as any).logger, "warn").mockImplementation(() => undefined);

    await expect(controller.createOrder(dtoOf() as any, MOCK_CTX as any)).rejects.toThrow(
      "db down",
    );
    expect(ordersService.findOne).not.toHaveBeenCalled();
  });

  it("R1: the POST-CREATE consolidation is called with { lockMode: 'try' } and, when it defers with the coded 503, the created order still comes back — one warning", async () => {
    ordersService.findActiveOrder.mockResolvedValue(null);
    ordersService.mergeAllPendingForCustomer.mockRejectedValueOnce(lockUnavailable());
    const warn = jest.spyOn((controller as any).logger, "warn").mockImplementation(() => undefined);

    const result = await controller.createOrder(dtoOf() as any, MOCK_CTX as any);

    // The row exists. Reporting a failure would have the buyer place a second order.
    expect(result).toEqual({ id: "order-fresh" });
    expect(ordersService.mergeAllPendingForCustomer).toHaveBeenCalledWith(
      MOCK_CTX.customerId,
      { buyerInitiated: true },
      { lockMode: "try" },
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("R1: post-create — a NON-contention failure from the consolidation still propagates", async () => {
    ordersService.findActiveOrder.mockResolvedValue(null);
    ordersService.mergeAllPendingForCustomer.mockRejectedValueOnce(new Error("db down"));
    jest.spyOn((controller as any).logger, "warn").mockImplementation(() => undefined);

    await expect(controller.createOrder(dtoOf() as any, MOCK_CTX as any)).rejects.toThrow(
      "db down",
    );
  });

  it("R4: a lock that is NOT acquired is the coded 503 — never a silent fall-through to a second order", async () => {
    locks.withAdvisoryLock.mockResolvedValueOnce({ acquired: false });

    let caught: any;
    try {
      await controller.createOrder(dtoOf() as any, MOCK_CTX as any);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect(caught?.getResponse?.()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
    // The whole point: `lock.acquired === false` used to read as "no active order".
    expect(ordersService.create).not.toHaveBeenCalled();
    expect(ordersService.updateOrderItems).not.toHaveBeenCalled();
  });

  it("forceNew skips the lock entirely — no merge, nothing to serialize", async () => {
    const dto = { forceNew: true, items: [{ productId: "prod-a", qty: 3 }] };

    await controller.createOrder(dto as any, MOCK_CTX as any);

    expect(locks.withAdvisoryLock).not.toHaveBeenCalled();
    expect(ordersService.create).toHaveBeenCalledTimes(1);
  });
});
