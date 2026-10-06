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
import { FeatureConfigService } from "../billing/feature-config.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * Standing orders take the path order create would give them (the shared resolver) for EVERY tenant
 * (SA-678 MUST 2): a ship-only business ships; elsewhere the customer's own stored path, then ROUTE.
 */
describe("OrderTemplatesService fulfil path", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let read: jest.Mock;
  let orders: { mergeAllPendingForCustomer: jest.Mock };
  const resolve = resolveOversellAllowed as unknown as jest.Mock;
  const decrement = decrementStockForSale as jest.Mock;
  const realResolver = (OrdersService.prototype as any).resolveBuyerLinePrice;

  async function build(mode: string | Error) {
    prisma = createMockPrisma();
    read = jest.fn().mockResolvedValue("off");
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
        {
          provide: FeatureConfigService,
          useValue: {
            getEffectiveMode: jest.fn(async () => {
              if (mode instanceof Error) throw mode;
              return mode;
            }),
          },
        },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);
    orders = mod.get(OrdersService);
    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    // a customer made before the business switched: the stored path is the column default, ROUTE
    prisma.customer.findFirst.mockResolvedValue({ fulfillPath: "ROUTE" });
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
  const createData = () => prisma.order.create.mock.calls.at(-1)?.[0]?.data;

  it("(d) ship-only tenant, stored-ROUTE customer: the generated order ships", async () => {
    await build("ship");
    await service.generateOrderForUser("t1", staff);
    expect(createData().fulfillPath).toBe("SHIP");
  });

  it.each(["unset", "delivery", "both"])(
    "%s tenant: a stored-ROUTE customer's standing order is ROUTE, as today",
    async (mode) => {
      await build(mode);
      await service.generateOrderForUser("t1", staff);
      expect(createData().fulfillPath).toBe("ROUTE");
    },
  );

  it("SA-678: unset tenant, SHIP customer: the standing order is SHIP and the sweep folds that path", async () => {
    await build("unset");
    prisma.customer.findFirst.mockResolvedValue({ fulfillPath: "SHIP" });
    await service.generateOrderForUser("t1", staff);
    expect(createData().fulfillPath).toBe("SHIP");
    // the post-create sweep folds the standing order's own path group (its SHIP orders), nothing else
    expect(orders.mergeAllPendingForCustomer).toHaveBeenCalledWith(
      "c1",
      { focusOrderId: "o1" },
      expect.anything(),
    );
  });

  it("(g) SA-678: an unreadable capability fails open to the customer's path and the order is created", async () => {
    await build(new Error("db down"));
    await service.generateOrderForUser("t1", staff);
    expect(createData().fulfillPath).toBe("ROUTE");
  });
});
