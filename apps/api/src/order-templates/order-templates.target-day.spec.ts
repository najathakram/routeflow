jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

/**
 * B326 / SA-964 §1: a standing order's requestedDeliveryDate is the run's TARGET DAY (a UTC-midnight calendar stamp), the
 * same day whose weekday picked the template; a manual generate stamps the tenant's calendar day. Harness copied from
 * order-templates.restrictions.spec.ts.
 * F-05 (#2093, owner rulings 2026-09-25, SA-205/SA-210) — a standing order SELLS its lines.
 *  - a MANUAL run (Generate now / Reorder) is refused with the 409 (the operator decides);
 *  - the UNATTENDED run skips the banned line(s), orders the rest, notifies once and suspends THAT template
 *    line (an AuditLog row); an all-banned or all-suspended template orders nothing, still with a notice;
 *  - the run's channel follows the template's snapshotted creator through the live predicate, and unknown
 *    provenance (NULL) is the STRICTER buyer channel, never staff, EXCEPT that a legacy template (a NULL role
 *    beside known staff) is staff-built, so a portal-only limit never suspends its lines (a legal ban still does);
 *  - an edit keeps a line's suspension unless THAT line's product or qty changed (audited lift); an explicit
 *    lift is its own audited action.
 * The choke point itself is proven in `selling-restrictions.service.spec.ts`.
 */
jest.mock("../common/tenant-time-zone", () => ({
  tenantTimeZone: jest.fn().mockResolvedValue("UTC"),
}));

import { tenantTimeZone } from "../common/tenant-time-zone";
import { regulatedGateOpenProvider } from "./testing/regulated-gate-open-provider";
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { OrderTemplatesService } from "./order-templates.service";
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
import { wireStockHelper } from "../inventory/testing/stock-helper-mock";

describe("OrderTemplatesService — requestedDeliveryDate is the target day (B326)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const restrictions = { assertLinesSellable: jest.fn(), checkLinesSellable: jest.fn() };
  const notifications = { sendToCustomer: jest.fn(), sendToUser: jest.fn() };
  const audit = { log: jest.fn() };
  const authGuard = { checkAuthorized: jest.fn() };
  const entitlements = { hasFlagStrict: jest.fn() };
  const ordersService = {
    entitlements,
    mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
    loadActivePromotions: jest.fn(),
    getCustomerPriceHistory: jest.fn(),
    resolveBuyerLinePrice: jest.fn((...args: any[]) =>
      (OrdersService.prototype as any).resolveBuyerLinePrice(...args),
    ),
  };
  const line = (productId: string, extra: object = {}) => ({
    productId,
    qty: 2,
    notes: null,
    ...extra,
  });
  const template = (over: object = {}) => ({
    id: "t1",
    customerId: "c1",
    name: "Weekly",
    isActive: true,
    createdByRole: "OPERATOR",
    items: [line("p-banned"), line("p-ok")],
    ...over,
  });
  const block = {
    outcome: "BLOCK",
    reasons: [{ productId: "p-banned", productName: "Banned Cola", ruleId: "rule-1" }],
  };
  /** The customer has a typed unit price, so the units_prices_v2 flag is consulted (and can fail). */
  const typedPrice = (rows: object[]) => {
    (prisma.forTenant() as any).customerUnitPrice = { findMany: jest.fn().mockResolvedValue(rows) };
  };
  /** The unattended 06:00 run, through the real cron entry (its caller sends the ban notice). */
  const run = async (t: object) => {
    prisma.tenant.findMany.mockResolvedValue([{ id: "tn-1" }]);
    prisma.orderTemplate.findMany.mockResolvedValue([t]);
    prisma.orderTemplate.count.mockResolvedValue(0);
    prisma.order.findFirst.mockResolvedValue(null);
    await service.generateDailyOrders();
    return prisma.order.create.mock.calls.length > 0 ? { ordered: true } : null;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    wireStockHelper(prisma, { ample: true });
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
        oversellReaderOffProvider,
        OrderTemplatesService,
        regulatedGateOpenProvider,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_i, fn) => fn()) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: ordersService },
        { provide: AuthorizationGuardService, useValue: authGuard },
        { provide: NotificationsService, useValue: notifications },
        { provide: SellingRestrictionsService, useValue: restrictions },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);
    prisma.orderTemplate.findUnique.mockResolvedValue(template());
    prisma.product.findMany.mockResolvedValue([
      { id: "p-banned", pricePerUnit: 10, trackedCategoryId: null },
      { id: "p-ok", pricePerUnit: 5, trackedCategoryId: null },
    ]);
    prisma.order.create.mockImplementation((a: any) => Promise.resolve({ id: "o1", ...a.data }));
    prisma.user.findMany.mockResolvedValue([{ id: "op1" }]);
  });

  afterEach(() => jest.useRealTimers());
  const stamped = () => prisma.order.create.mock.calls[0][0].data.requestedDeliveryDate;

  it("the 06:00Z cron stamps the run's target day: 00:00Z of that UTC day, not the 06:00 instant", async () => {
    jest.useFakeTimers({
      now: new Date("2026-10-27T06:00:00Z"),
      doNotFake: ["setTimeout", "setInterval", "setImmediate", "nextTick", "queueMicrotask"],
    });
    await run(template());
    expect(stamped()).toEqual(new Date("2026-10-27T00:00:00.000Z"));
  });

  it("a list filter deliveryDateTo = that day includes the stamped order (lte new Date(D))", async () => {
    jest.useFakeTimers({
      now: new Date("2026-10-27T06:00:00Z"),
      doNotFake: ["setTimeout", "setInterval", "setImmediate", "nextTick", "queueMicrotask"],
    });
    await run(template());
    expect(stamped().getTime()).toBeLessThanOrEqual(new Date("2026-10-27").getTime());
  });

  it("a manual generate by a Los Angeles tenant at 05:00Z on the 27th (22:00 PDT on the 26th) stamps the 26th", async () => {
    jest.useFakeTimers({
      now: new Date("2026-10-27T05:00:00Z"),
      doNotFake: ["setTimeout", "setInterval", "setImmediate", "nextTick", "queueMicrotask"],
    });
    (tenantTimeZone as jest.Mock).mockResolvedValue("America/Los_Angeles");
    await service.generateOrder("t1", true);
    expect(stamped()).toEqual(new Date("2026-10-26T00:00:00.000Z"));
  });

  it("control: a UTC tenant's manual generate at the same instant stamps the 27th", async () => {
    jest.useFakeTimers({
      now: new Date("2026-10-27T05:00:00Z"),
      doNotFake: ["setTimeout", "setInterval", "setImmediate", "nextTick", "queueMicrotask"],
    });
    (tenantTimeZone as jest.Mock).mockResolvedValue("UTC");
    await service.generateOrder("t1", true);
    expect(stamped()).toEqual(new Date("2026-10-27T00:00:00.000Z"));
  });
});
