jest.mock("../orders/order-stock", () => ({
  ...jest.requireActual("../orders/order-stock"),
  decrementStockForSale: jest.fn(),
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
import { decrementStockForSale, stockWriteOf } from "../orders/order-stock";
import { resolveOversellAllowed } from "../orders/oversell-policy";
import { PolicyOversellReader } from "../orders/policy-oversell-reader";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * B975 (SA-606q): the buyer Reorder (generateOrder) reports the same per-line `backorderPieces` as the
 * buyer's checkout. The template service hands the locked write back on the order it returns (the
 * non-enumerable carrier), so the BuyerController can map it; the staff manual run and the 06:00
 * cron never map it. Harness copied from order-templates.oversell-call-sites.spec.ts.
 */
describe("OrderTemplatesService returns the locked write (B975)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let merge: jest.Mock;
  const decrement = decrementStockForSale as jest.Mock;
  const realResolver = (OrdersService.prototype as any).resolveBuyerLinePrice;
  const write = (n: number) => ({ backorderByProduct: new Map([["p1", n]]) });

  async function build(opts: { pack?: number | null; qty?: number } = {}) {
    const pack = opts.pack ?? null;
    prisma = createMockPrisma();
    (resolveOversellAllowed as unknown as jest.Mock).mockClear();
    decrement.mockReset().mockResolvedValue({ backorderByProduct: new Map() });
    merge = jest.fn().mockResolvedValue(null);
    const mod = await Test.createTestingModule({
      providers: [
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        {
          provide: OrdersService,
          useValue: {
            mergeAllPendingForCustomer: merge,
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
          provide: PolicyOversellReader,
          useValue: { read: jest.fn().mockResolvedValue("backorder") },
        },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);
    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.trackedCategory.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", pricePerUnit: 10, unitsPerBox: pack, trackedCategoryId: null },
    ]);
    // Honour the include the way Prisma would: the product's pack is present ONLY if it was selected.
    prisma.order.create.mockImplementation((a: any) => {
      const select = a.include?.lineItems?.include?.product?.select ?? {};
      const lineItems = a.data.lineItems.create.map((li: any, i: number) => ({
        id: `l${i}`,
        status: "PENDING",
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        unitLabel: null,
        ...li,
        product: {
          id: li.productId,
          name: "Widget",
          unit: "case",
          ...(select.unitsPerBox ? { unitsPerBox: pack } : {}),
        },
      }));
      return Promise.resolve({
        id: "o1",
        skipAutoMerge: false, // a default (merge-eligible) template order
        ...a.data,
        lineItems,
        customer: { id: "c1" },
      });
    });
    prisma.orderTemplate.findUnique.mockResolvedValue({
      id: "t1",
      customerId: "c1",
      name: "Weekly",
      isActive: true,
      items: [{ productId: "p1", qty: opts.qty ?? 3, notes: null }],
    });
  }
  const staff = { sub: "u-op", role: "OPERATOR", tenantId: "test-tenant" } as unknown as JwtPayload;

  it("generateOrder returns the order carrying the decrement's result, nothing on the wire", async () => {
    await build();
    decrement.mockResolvedValue(write(3));
    const order: any = await service.generateOrder("t1", false, true);
    expect(stockWriteOf(order)?.backorderByProduct.get("p1")).toBe(3);
    expect(stockWriteOf(order)?.orderId).toBe("o1");
    expect(JSON.stringify(order)).not.toMatch(/backorder/i);
  });

  it("a fold into another order: the SWEPT order comes back (as on master), carrying the CREATED order's write and its id", async () => {
    await build();
    decrement.mockResolvedValue(write(3));
    const merged = { id: "o-merged", lineItems: [] };
    merge.mockResolvedValue(merged);
    const order: any = await service.generateOrder("t1", false, true);
    expect(order).toBe(merged);
    expect(stockWriteOf(order)?.backorderByProduct.get("p1")).toBe(3);
    expect(stockWriteOf(order)?.orderId).toBe("o1"); // the created order, so the controller can re-read it by id
  });

  it("no other pending order: the sweep's BARE row comes back (unchanged), carrying the write and the created order's id", async () => {
    await build();
    decrement.mockResolvedValue(write(3));
    const bare = {
      id: "o1",
      customerId: "c1",
      lineItems: [{ id: "l0", productId: "p1", qty: 3, status: "PENDING" }],
    };
    merge.mockResolvedValue(bare);
    const order: any = await service.generateOrder("t1", false, true);
    expect(order).toBe(bare); // not rewritten: staff and cron responses are exactly master's
    expect(stockWriteOf(order)?.orderId).toBe("o1");
    expect(JSON.stringify(order)).not.toMatch(/backorder/i);
  });

  it("the created order's lines keep master's narrow product select: the Reorder's pack comes from the findOne re-read, so staff and cron responses are unchanged", async () => {
    await build();
    await service.generateOrder("t1", false, true);
    const lineItems = (prisma.order.create as jest.Mock).mock.calls[0][0].include.lineItems;
    expect(lineItems.include.product.select).toEqual({ id: true, name: true, unit: true });
    expect(lineItems.orderBy).toBeUndefined();
  });

  it("the staff manual run returns no figure on the wire (the service carries it, nothing maps it)", async () => {
    await build();
    decrement.mockResolvedValue(write(3));
    const order: any = await service.generateOrderForUser("t1", staff);
    expect(stockWriteOf(order)?.backorderByProduct.get("p1")).toBe(3);
    expect(JSON.stringify(order)).not.toMatch(/backorder/i);
    expect(order.lineItems.every((l: any) => !("backorderPieces" in l))).toBe(true);
  });
});
