import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test } from "@nestjs/testing";
import { OrderTemplatesService } from "./order-templates.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { BadRequestException } from "@nestjs/common";

/**
 * REG-B1025: a standing order / buyer "Reorder" kept ordering a product that had since been
 * DEACTIVATED (archived), at full price. The interactive create path rejects an archived line
 * ("Product X is archived"); the template path never looked at `isActive`. A deactivated line is now
 * treated like the path's other unusable lines (suspended, license-gated): SKIPPED with a readable
 * note and a notice to both sides while the rest is ordered, and when NOTHING usable is left the manual
 * run refuses with a readable 400 (the cron run creates no order). Only the database is mocked.
 */
jest.mock("../orders/order-stock", () => ({
  decrementStockForSale: jest.fn().mockResolvedValue(undefined),
}));

// @LeaderCron wraps generateDailyOrders in a Postgres advisory lock (common/cron-lock.ts).
// There is no database here, so the lock is a PASS-THROUGH that still runs the body — same
// mock as order-templates.removed-customer.spec.ts / recurring-invoices.service.spec.ts.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

describe("OrderTemplatesService — deactivated product on a standing order (REG-B1025)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let notifications: { sendToCustomer: jest.Mock; sendToUser: jest.Mock };
  const realResolver = (OrdersService.prototype as any).resolveBuyerLinePrice;

  beforeEach(async () => {
    prisma = createMockPrisma();
    notifications = {
      sendToCustomer: jest.fn().mockResolvedValue(1),
      sendToUser: jest.fn().mockResolvedValue(1),
    };
    const ordersService = {
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      loadActivePromotions: jest.fn().mockResolvedValue([]),
      getCustomerPriceHistory: jest.fn().mockResolvedValue({}),
      resolveBuyerLinePrice: jest.fn((...args: any[]) => realResolver(...args)),
    };
    const mod = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: ordersService },
        {
          provide: AuthorizationGuardService,
          useValue: { checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }) },
        },
        { provide: NotificationsService, useValue: notifications },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: SellingRestrictionsService,
          useValue: {
            assertLinesSellable: jest.fn().mockResolvedValue(undefined),
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);

    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.trackedCategory.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([{ id: "op1" }]);
    prisma.order.create.mockImplementation((a: any) => Promise.resolve({ id: "o1", ...a.data }));
  });

  const product = (id: string, isActive: boolean) => ({
    id,
    name: `Product ${id}`,
    sku: `SKU-${id}`,
    pricePerUnit: 10,
    unitsPerBox: null,
    trackedCategoryId: null,
    isActive,
  });

  function setup(lines: Array<{ id: string; isActive: boolean }>) {
    prisma.product.findMany.mockResolvedValue(lines.map((l) => product(l.id, l.isActive)));
    prisma.orderTemplate.findUnique.mockResolvedValue({
      id: "t1",
      customerId: "c1",
      name: "Weekly",
      isActive: true,
      items: lines.map((l) => ({ productId: l.id, qty: 2, notes: null })),
    });
  }

  const orderedProductIds = () =>
    prisma.order.create.mock.calls[0][0].data.lineItems.create.map((l: any) => l.productId);

  it("a template holding only an active product still orders it (control)", async () => {
    setup([{ id: "p-active", isActive: true }]);
    await service.generateOrder("t1", false, false);
    expect(orderedProductIds()).toEqual(["p-active"]);
  });

  it("a buyer reorder never orders a deactivated product", async () => {
    setup([
      { id: "p-active", isActive: true },
      { id: "p-gone", isActive: false },
    ]);

    await service.generateOrder("t1", false, false);

    // Before the fix both lines were ordered, the deactivated one at full price.
    expect(orderedProductIds()).toEqual(["p-active"]);
    const data = prisma.order.create.mock.calls[0][0].data;
    expect(data.subtotal).toBe(20); // 2 x 10 for the active line only
    expect(data.notes).toMatch(/1 .*skipped/i);
  });

  it("tells the customer and the operators which line was skipped", async () => {
    setup([
      { id: "p-active", isActive: true },
      { id: "p-gone", isActive: false },
    ]);

    await service.generateOrder("t1", false, false);

    expect(notifications.sendToCustomer).toHaveBeenCalledWith(
      "c1",
      expect.any(String),
      expect.stringContaining("no longer available"),
    );
    expect(notifications.sendToUser).toHaveBeenCalledWith(
      "op1",
      expect.objectContaining({ body: expect.stringContaining("Weekly") }),
    );
  });

  it("refuses with a readable 400 when every line is deactivated, creating no order", async () => {
    setup([
      { id: "p-gone", isActive: false },
      { id: "p-gone-2", isActive: false },
    ]);

    await expect(service.generateOrder("t1", false, false)).rejects.toThrow(BadRequestException);
    await expect(service.generateOrder("t1", false, false)).rejects.toThrow(/no longer available/i);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("the unattended cron run skips a deactivated line the same way", async () => {
    setup([
      { id: "p-active", isActive: true },
      { id: "p-gone", isActive: false },
    ]);
    const template = await prisma.orderTemplate.findUnique();

    await (service as any).createOrderFromTemplate(template, true, true, { ban: null });

    expect(orderedProductIds()).toEqual(["p-active"]);
  });

  it("the unattended cron run creates no order when every line is deactivated", async () => {
    setup([{ id: "p-gone", isActive: false }]);
    const template = await prisma.orderTemplate.findUnique();

    const result = await (service as any).createOrderFromTemplate(template, true, true, {
      ban: null,
    });

    expect(result).toBeNull();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});
