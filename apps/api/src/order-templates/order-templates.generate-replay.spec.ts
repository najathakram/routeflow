jest.mock("../orders/order-stock", () => ({
  decrementStockForSale: jest.fn().mockResolvedValue(undefined),
}));
// @LeaderCron wraps generateDailyOrders in an advisory lock; no DB here, so a pass-through.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { OrderTemplatesService } from "./order-templates.service";
import { GENERATE_NOW_REPLAY_WINDOW_MS } from "./generate-replay";
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { AuditService } from "../audit/audit.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { decrementStockForSale } from "../orders/order-stock";

/**
 * B1054 review: the 06:00 cron takes the same row-locked replay check as a manual "Generate now"
 * (so a cron run and a manual run of one template cannot both place an order), and the accepted
 * limit for an order that lost a pending-order merge is pinned as the behaviour it is.
 * The real two-connection race is proven in order-templates.generate-race.db.spec.ts.
 */
describe("OrderTemplatesService generation replay (B1054)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let orders: { mergeAllPendingForCustomer: jest.Mock };
  const decrement = decrementStockForSale as jest.Mock;
  const realResolver = (OrdersService.prototype as any).resolveBuyerLinePrice;
  const template = {
    id: "t1",
    customerId: "c1",
    name: "Weekly",
    isActive: true,
    createdByRole: "OPERATOR",
    itemsEditedByRole: "OPERATOR",
    items: [{ productId: "p1", qty: 3, notes: null }],
  };
  const DAY_START = new Date("2026-01-15T00:00:00.000Z");

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        {
          provide: OrdersService,
          useValue: {
            mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
            loadActivePromotions: jest.fn().mockResolvedValue([]),
            getCustomerPriceHistory: jest.fn().mockResolvedValue({}),
            resolveBuyerLinePrice: jest.fn((...a: any[]) => realResolver(...a)),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: { checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }) },
        },
        {
          provide: NotificationsService,
          useValue: {
            sendToCustomer: jest.fn().mockResolvedValue(1),
            sendToUser: jest.fn().mockResolvedValue(1),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: SellingRestrictionsService,
          useValue: {
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn().mockResolvedValue("unset") },
        },
        oversellReaderOffProvider,
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);
    orders = mod.get(OrdersService);
    prisma.getTenantId.mockReturnValue("test-tenant");
    prisma.tenant.findMany.mockResolvedValue([{ id: "tn-1" }]);
    prisma.orderTemplate.findMany.mockResolvedValue([template]);
    prisma.orderTemplate.count.mockResolvedValue(0);
    prisma.orderTemplate.findUnique.mockResolvedValue(template);
    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    prisma.customer.findFirst.mockResolvedValue({ fulfillPath: "ROUTE" });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.trackedCategory.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: null },
    ]);
    prisma.order.create.mockImplementation((a: any) => Promise.resolve({ id: "o1", ...a.data }));
  });

  afterEach(() => jest.useRealTimers());

  const fakeCronClock = () =>
    jest.useFakeTimers({
      now: new Date("2026-01-15T06:00:00.000Z"),
      doNotFake: [
        "nextTick",
        "setImmediate",
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "queueMicrotask",
      ],
    });

  it("cron: the order transaction re-reads with a replaySince of the UTC day start and answers a twin", async () => {
    fakeCronClock();
    const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    // call 1 = the unlocked "already generated today" check (nothing yet); call 2 = the locked
    // re-read inside the order transaction, where a concurrent manual run's order now shows up.
    prisma.order.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "manual-order", templateId: "t1" });

    await service.generateDailyOrders();

    expect(prisma.order.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.order.findFirst.mock.calls[1][0].where).toEqual({
      templateId: "t1",
      status: { not: "CANCELLED" },
      createdAt: { gte: DAY_START },
    });
    expect(prisma.order.create).not.toHaveBeenCalled(); // no second order...
    expect(decrement).not.toHaveBeenCalled(); // ...and no second stock decrement
    expect(orders.mergeAllPendingForCustomer).not.toHaveBeenCalled(); // so nothing to merge into double
    // the twin's order is counted as skipped, never as a cron-created order
    expect(log).toHaveBeenCalledWith(expect.stringContaining("0 created, 1 skipped"));
    log.mockRestore();
  });

  it("cron: with no twin it still places exactly one order and counts it created", async () => {
    fakeCronClock();
    const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    prisma.order.findFirst.mockResolvedValue(null);

    await service.generateDailyOrders();

    expect(prisma.order.findFirst.mock.calls[1][0].where.createdAt).toEqual({ gte: DAY_START });
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1 created, 0 skipped"));
    log.mockRestore();
  });

  it("accepted limit: an order that lost a merge is not a replay target, so a retry in the window places a new one", async () => {
    // The first press's order was folded into a newer winner and its row deleted, so the
    // template-keyed lookup finds nothing (the winner carries ANOTHER template's id, or none).
    prisma.order.findFirst.mockResolvedValue(null);

    await service.generateOrder("t1");

    const lookups = prisma.order.findFirst.mock.calls.map((c: any[]) => c[0].where);
    expect(lookups.length).toBeGreaterThanOrEqual(1);
    for (const where of lookups) {
      expect(where.templateId).toBe("t1"); // keyed on the template, never on the customer
      expect(where.status).toEqual({ not: "CANCELLED" });
      expect(where.createdAt.gte).toBeInstanceOf(Date);
      expect(Date.now() - where.createdAt.gte.getTime()).toBeLessThanOrEqual(
        GENERATE_NOW_REPLAY_WINDOW_MS + 5_000,
      );
    }
    expect(prisma.order.create).toHaveBeenCalledTimes(1); // the documented outcome: a NEW order
  });
});
