jest.mock("../orders/order-stock", () => ({
  decrementStockForSale: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../orders/oversell-policy", () => {
  const actual = jest.requireActual("../orders/oversell-policy");
  return { ...actual, resolveOversellAllowed: jest.fn(actual.resolveOversellAllowed) };
});
// @LeaderCron wraps generateDailyOrders in an advisory lock; no DB here, so a pass-through.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

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
import { decrementStockForSale } from "../orders/order-stock";
import { resolveOversellAllowed } from "../orders/oversell-policy";
import { PolicyOversellReader } from "../orders/policy-oversell-reader";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * WS9 call-site contract for standing orders (RED until the call-site PR): OrderTemplatesService
 * resolves the oversell policy ONCE per generated order, BEFORE its tenantTransaction, and hands the
 * BOOLEAN to decrementStockForSale (which replaces the hard-wired `isStaffRole`).
 *   - a manual run by staff:   source "staff_entry", role = the caller's, no policy read
 *   - a manual run by a buyer: source "buyer", role CUSTOMER, the template's customerId, one read
 *   - the unattended 06:00 cron: source "template_cron" (true for every role, no read). Q6 (standing
 *     orders vs out-of-stock) is UNANSWERED: this pins CURRENT behaviour, pending Q6.
 * Harness copied from order-templates.stock-and-levy.spec.ts plus PolicyOversellReader (L-247).
 */
describe("OrderTemplatesService oversell call sites", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let read: jest.Mock;
  const resolve = resolveOversellAllowed as unknown as jest.Mock;
  const decrement = decrementStockForSale as jest.Mock;
  const realResolver = (OrdersService.prototype as any).resolveBuyerLinePrice;

  async function build(policy: unknown) {
    prisma = createMockPrisma();
    read = jest.fn().mockResolvedValue(policy);
    resolve.mockClear();
    decrement.mockClear();
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
        { provide: PolicyOversellReader, useValue: { read } },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);
    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.trackedCategory.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: null },
    ]);
    prisma.order.create.mockImplementation((a: any) => Promise.resolve({ id: "o1", ...a.data }));
    prisma.orderTemplate.findUnique.mockResolvedValue({
      id: "t1",
      customerId: "c1",
      name: "Weekly",
      isActive: true,
      items: [{ productId: "p1", qty: 3, notes: null }],
    });
  }

  const staff = { sub: "u-op", role: "OPERATOR", tenantId: "test-tenant" } as unknown as JwtPayload;
  const buyer = { sub: "u-c", role: "CUSTOMER", tenantId: "test-tenant" } as unknown as JwtPayload;
  const beforeTx = () =>
    expect(resolve.mock.invocationCallOrder[0]).toBeLessThan(
      (prisma.tenantTransaction as jest.Mock).mock.invocationCallOrder[0],
    );

  it("staff manual run: source staff_entry, one resolve before the transaction, true reaches the stock helper, no read", async () => {
    await build("off");
    await service.generateOrderForUser("t1", staff);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ read }),
      expect.objectContaining({ tenantId: "test-tenant", role: "OPERATOR", source: "staff_entry" }),
    );
    beforeTx();
    expect(decrement).toHaveBeenCalledTimes(1);
    expect(decrement.mock.calls[0][3]).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["backorder", true],
    ["off", false],
  ])(
    "buyer manual run (policy %s): source buyer + the template customerId, one read, boolean %s",
    async (policy, want) => {
      await build(policy);
      prisma.customer.findFirst.mockResolvedValue({ id: "c1" });
      await service.generateOrderForUser("t1", buyer);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith(
        expect.objectContaining({ read }),
        expect.objectContaining({
          tenantId: "test-tenant",
          role: "CUSTOMER",
          source: "buyer",
          customerId: "c1",
        }),
      );
      expect(read).toHaveBeenCalledTimes(1);
      beforeTx();
      expect(decrement.mock.calls[0][3]).toBe(want);
      expect(typeof decrement.mock.calls[0][3]).toBe("boolean");
    },
  );

  it("unattended cron: source template_cron, one resolve per generated order before the transaction, true, no read (current behaviour, pending Q6)", async () => {
    await build("off");
    prisma.tenant.findMany.mockResolvedValue([{ id: "tn-1" }] as any);
    prisma.orderTemplate.findMany.mockResolvedValue([
      {
        id: "t1",
        customerId: "c1",
        name: "Weekly",
        isActive: true,
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        items: [{ productId: "p1", qty: 3, notes: null }],
        customer: { id: "c1", deletedAt: null },
      },
    ] as any);
    prisma.orderTemplate.count.mockResolvedValue(0);
    prisma.order.findFirst.mockResolvedValue(null);

    await service.generateDailyOrders();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ read }),
      expect.objectContaining({ source: "template_cron" }),
    );
    beforeTx();
    expect(decrement).toHaveBeenCalledTimes(1);
    expect(decrement.mock.calls[0][3]).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});
