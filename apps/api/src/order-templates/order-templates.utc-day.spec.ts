jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

/**
 * B955: the daily generator's "already generated today" idempotency window must start at the UTC
 * calendar day's midnight (startOfUtcDay), the same boundary the stored UTC dates use, not the
 * host's local midnight. Only Date is faked (the rest of the clock stays real so awaits run).
 */
import { Test } from "@nestjs/testing";
import { OrderTemplatesService } from "./order-templates.service";
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { AuditService } from "../audit/audit.service";
import * as orderStock from "../orders/order-stock";
import { createMockPrisma } from "../testing/prisma-mock";

describe("OrderTemplatesService.generateDailyOrders — UTC day window (B955)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const restrictions = { assertLinesSellable: jest.fn(), checkLinesSellable: jest.fn() };
  const notifications = { sendToCustomer: jest.fn(), sendToUser: jest.fn() };
  const audit = { log: jest.fn() };
  const authGuard = { checkAuthorized: jest.fn() };
  const ordersService = {
    mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
    loadActivePromotions: jest.fn(),
    getCustomerPriceHistory: jest.fn(),
    resolveBuyerLinePrice: jest.fn(),
  };
  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue("test-tenant");
    restrictions.assertLinesSellable.mockResolvedValue(undefined);
    restrictions.checkLinesSellable.mockResolvedValue({ outcome: "ALLOW", reasons: [] });
    notifications.sendToCustomer.mockResolvedValue(1);
    notifications.sendToUser.mockResolvedValue(1);
    audit.log.mockResolvedValue(undefined);
    authGuard.checkAuthorized.mockResolvedValue({ blocked: [] });
    ordersService.mergeAllPendingForCustomer.mockResolvedValue(null);
    ordersService.loadActivePromotions.mockResolvedValue([]);
    ordersService.getCustomerPriceHistory.mockResolvedValue({});
    const mod = await Test.createTestingModule({
      providers: [
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_i, fn) => fn()) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: ordersService },
        { provide: AuthorizationGuardService, useValue: authGuard },
        { provide: NotificationsService, useValue: notifications },
        { provide: SellingRestrictionsService, useValue: restrictions },
        { provide: AuditService, useValue: audit },
        oversellReaderOffProvider, // L-247: OrderTemplatesService now injects PolicyOversellReader (WS9)
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);
  });

  afterEach(() => jest.useRealTimers());

  it("looks for an order created since the UTC midnight of the run's UTC day", async () => {
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
    prisma.tenant.findMany.mockResolvedValue([{ id: "tn-1" }]);
    prisma.orderTemplate.findMany.mockResolvedValue([
      { id: "t1", customerId: "c1", name: "Weekly", isActive: true, items: [] },
    ]);
    prisma.orderTemplate.count.mockResolvedValue(0);
    prisma.order.findFirst.mockResolvedValue({ id: "already" });

    await service.generateDailyOrders();

    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: { templateId: "t1", createdAt: { gte: new Date("2026-01-15T00:00:00.000Z") } },
    });
  });

  it("selects templates by the UTC ISO weekday (23:30Z Wednesday is already Thursday in Tokyo)", async () => {
    jest.useFakeTimers({
      now: new Date("2026-01-14T23:30:00.000Z"),
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
    prisma.tenant.findMany.mockResolvedValue([{ id: "tn-1" }]);
    prisma.orderTemplate.findMany.mockResolvedValue([]);
    prisma.orderTemplate.count.mockResolvedValue(0);

    await service.generateDailyOrders();

    expect(prisma.orderTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ daysOfWeek: { has: 3 } }), // Wednesday, UTC
      }),
    );
  });
});
