/**
 * Row 718 — the buyer's order submit refuses a requestedDeliveryDate before the TENANT's today (400
 * DELIVERY_DATE_IN_PAST) on the MERGE path too: a cart folded into the buyer's open order writes the date
 * through `applyBuyerMergeHeader`, whose own failures are deliberately swallowed (the lines are already
 * committed), so the check has to run BEFORE the fold. The fresh-create path is guarded inside
 * `OrdersService.create` (orders.service.delivery-date-guard.spec.ts).
 *
 * On a merge the date is a CHANGE of the open order's date: resending the order's own (now past) date, or
 * sending none, never blocks adding items.
 */

// The merge branch runs inside `withAdvisoryLock` (its own pg connection): a transparent pass-through here,
// exactly as buyer.controller.merge.spec.ts does. The lock's contract is pinned in buyer.merge-lock.spec.ts.
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
  return {
    withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
      acquired: true,
      value: await fn(),
    })),
    LockTimeoutError,
    LockUnavailableError,
  };
});

import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test, TestingModule } from "@nestjs/testing";
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

// A literal on purpose: this spec must go red on behaviour, not on a missing constant.
const CODE = "DELIVERY_DATE_IN_PAST";
const ONLY_DATE = [
  "hrtime",
  "nextTick",
  "performance",
  "queueMicrotask",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "setImmediate",
  "clearImmediate",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
] as const;
const at = (iso: string) => jest.useFakeTimers({ now: new Date(iso), doNotFake: [...ONLY_DATE] });

const MOCK_CTX = {
  customerId: "cust-merge-1",
  tenantId: "tenant-xyz",
  tenantSlug: "acme",
  userId: null, // buyer-portal-only account — no operator-portal user
  customer: { id: "cust-merge-1", businessName: "Merge Test Buyer" },
};

describe("BuyerController.createOrder — row 718 past delivery date guard", () => {
  let controller: BuyerController;
  let ordersService: {
    findActiveOrder: jest.Mock;
    liveTrioByProduct: jest.Mock;
    updateOrderItems: jest.Mock;
    applyBuyerMergeHeader: jest.Mock;
    mergeAllPendingForCustomer: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
    findOrderIdByIdempotencyKey: jest.Mock;
    replayMergeReconcile: jest.Mock;
    recordIdempotencyKey: jest.Mock;
  };
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    ordersService = {
      findActiveOrder: jest.fn().mockResolvedValue(null),
      liveTrioByProduct: jest.fn().mockResolvedValue(new Map()),
      updateOrderItems: jest.fn().mockResolvedValue(undefined),
      applyBuyerMergeHeader: jest.fn().mockResolvedValue(undefined),
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "order-fresh" }),
      findOne: jest.fn().mockResolvedValue({ id: "order-open" }),
      findOrderIdByIdempotencyKey: jest.fn().mockResolvedValue(null),
      replayMergeReconcile: jest.fn().mockResolvedValue(undefined),
      recordIdempotencyKey: jest.fn().mockResolvedValue(undefined),
    };
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuyerController],
      providers: [
        oversellReaderOffProvider,
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

  afterEach(() => jest.useRealTimers());

  const cart = { items: [{ productId: "prod-1", qty: 2 }] };
  const openOrder = (requestedDeliveryDate: Date | null) => ({
    id: "order-open",
    customerId: MOCK_CTX.customerId,
    requestedDeliveryDate,
    lineItems: [
      {
        id: "li-1",
        productId: "prod-1",
        qty: 1,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        unitPrice: 5,
        priceType: "STANDARD",
      },
    ],
  });
  const submit = (requestedDeliveryDate: string | undefined, key?: string) =>
    controller.createOrder({ ...cart, requestedDeliveryDate } as any, MOCK_CTX as any, key);

  describe("merge into the open order", () => {
    beforeEach(() => {
      at("2026-10-22T15:00:00Z");
      ordersService.findActiveOrder.mockResolvedValue(openOrder(null));
      prisma.product.findMany.mockResolvedValue([{ id: "prod-1", unitsPerBox: null }]);
    });

    it("a past day is refused 400 DELIVERY_DATE_IN_PAST before anything is folded or written", async () => {
      await expect(submit("2026-10-21")).rejects.toMatchObject({
        response: { code: CODE, today: "2026-10-22" },
      });
      expect(ordersService.updateOrderItems).not.toHaveBeenCalled();
      expect(ordersService.applyBuyerMergeHeader).not.toHaveBeenCalled();
      expect(ordersService.mergeAllPendingForCustomer).not.toHaveBeenCalled();
    });

    it("measures on the tenant's day: UTC is on the 23rd, the tenant is still on the 22nd", async () => {
      at("2026-10-23T03:00:00Z");
      prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "America/Los_Angeles" });
      await submit("2026-10-22");
      expect(ordersService.updateOrderItems).toHaveBeenCalledTimes(1);
      await expect(submit("2026-10-21")).rejects.toMatchObject({ response: { code: CODE } });
    });

    it.each(["2026-10-22", "2026-10-30"])(
      "today or later (%s) merges and forwards the date",
      async (day) => {
        await submit(day);
        expect(ordersService.updateOrderItems).toHaveBeenCalledTimes(1);
        expect(ordersService.applyBuyerMergeHeader).toHaveBeenCalledWith(
          "order-open",
          expect.objectContaining({ requestedDeliveryDate: day }),
          expect.anything(),
        );
      },
    );

    it("no date at all: untouched", async () => {
      await submit(undefined);
      expect(ordersService.updateOrderItems).toHaveBeenCalledTimes(1);
    });

    it("the open order's own past date, resent unchanged, still merges (not a change)", async () => {
      ordersService.findActiveOrder.mockResolvedValue(openOrder(new Date("2026-10-10T00:00:00Z")));
      await submit("2026-10-10");
      expect(ordersService.updateOrderItems).toHaveBeenCalledTimes(1);
    });

    it("a change from the open order's past date to a DIFFERENT past day is refused", async () => {
      ordersService.findActiveOrder.mockResolvedValue(openOrder(new Date("2026-10-10T00:00:00Z")));
      await expect(submit("2026-10-11")).rejects.toMatchObject({ response: { code: CODE } });
      expect(ordersService.updateOrderItems).not.toHaveBeenCalled();
    });

    it("a replayed submit (same Idempotency-Key) returns the original even after its day has passed", async () => {
      ordersService.findOrderIdByIdempotencyKey.mockResolvedValue({ orderId: "order-open" });
      await expect(submit("2026-10-21", "key-1")).resolves.toBeDefined();
      expect(ordersService.updateOrderItems).not.toHaveBeenCalled();
    });
  });
});
