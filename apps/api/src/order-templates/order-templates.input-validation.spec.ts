/**
 * Order template input validation: the buyer template PATCH route takes the real, validated template body
 * type (a quantity must be a whole number >= 1, unknown keys are refused), and the service refuses a
 * non-positive line quantity itself on create, update and every run, so a quantity that bypasses the pipe
 * (an older client, a stored row, a direct caller) can never reach stock or an order.
 */
import { regulatedGateOpenProvider } from "./testing/regulated-gate-open-provider";
import "reflect-metadata";
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

import { ValidationPipe } from "@nestjs/common";
import { BuyerController } from "../buyer/buyer.controller";
import { UpdateOrderTemplateDto } from "./dto/update-order-template.dto";
import { UpdateBuyerOrderTemplateDto } from "./dto/update-buyer-order-template.dto";
import { CreateOrderTemplateDto } from "./dto/create-order-template.dto";
import { decrementStockForSale } from "../orders/order-stock";

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

describe("order template input validation", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let notifications: { sendToCustomer: jest.Mock; sendToUser: jest.Mock };
  let checkLinesSellable: jest.Mock;
  const realResolver = (OrdersService.prototype as any).resolveBuyerLinePrice;

  beforeEach(async () => {
    prisma = createMockPrisma();
    checkLinesSellable = jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] });
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
        regulatedGateOpenProvider,
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
            checkLinesSellable,
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

  // A stateful stand-in for the template rows: the writes the service makes (suspend, lift, deactivate)
  // are visible to the NEXT run, so "two consecutive runs" really is two runs over the persisted state.
  let tpl: any;
  function setup(lines: Array<{ id: string; isActive: boolean }>) {
    prisma.product.findMany.mockResolvedValue(lines.map((l) => product(l.id, l.isActive)));
    tpl = {
      id: "t1",
      customerId: "c1",
      name: "Weekly",
      isActive: true,
      items: lines.map((l, i) => ({
        id: `i${i}`,
        productId: l.id,
        qty: 2,
        notes: null,
        suspendedAt: null,
        suspendedReason: null,
      })),
    };
    prisma.orderTemplate.findUnique.mockImplementation(async () => ({
      ...tpl,
      items: tpl.items.map((i: any) => ({ ...i })),
    }));
    prisma.orderTemplateItem.updateMany.mockImplementation(async ({ where, data }: any) => {
      // like Postgres: only the rows matching the WHERE (incl. `suspendedAt: null`) are written
      let count = 0;
      for (const i of tpl.items)
        if (
          where.productId.in.includes(i.productId) &&
          (!("suspendedAt" in where) || i.suspendedAt === where.suspendedAt)
        ) {
          Object.assign(i, data);
          count++;
        }
      return { count };
    });
    prisma.orderTemplateItem.findFirst.mockImplementation(
      async ({ where }: any) => tpl.items.find((i: any) => i.id === where.id) ?? null,
    );
    prisma.orderTemplateItem.update.mockImplementation(async ({ where, data }: any) =>
      Object.assign(
        tpl.items.find((i: any) => i.id === where.id),
        data,
      ),
    );
    prisma.orderTemplate.update.mockImplementation(async ({ data }: any) =>
      Object.assign(tpl, data),
    );
  }
  const ZERO_MSG = /greater than zero/i;
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const bodyType = () =>
    Reflect.getMetadata("design:paramtypes", BuyerController.prototype, "updateTemplate")[1];

  it("(a) the buyer template PATCH handler takes the buyer-specific body type, not an inline object", () => {
    expect(bodyType()).toBe(UpdateBuyerOrderTemplateDto);
  });

  it.each([
    ["a negative quantity", { items: [{ productId: "p1", qty: -5 }] }],
    ["a zero quantity", { items: [{ productId: "p1", qty: 0 }] }],
    ["a fractional quantity", { items: [{ productId: "p1", qty: 1.5 }] }],
    ["an unknown key", { isActive: true, whatever: 1 }],
    ["an item list at all", { items: [{ productId: "p1", qty: 3 }] }],
    ["a name change", { name: "x" }],
  ])("(b) the validation pipe refuses %s on that route", async (_n, body) => {
    await expect(
      pipe.transform(body, { type: "body", metatype: bodyType() }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("(c) control: the pipe accepts the pause/resume body and a valid item list", async () => {
    await expect(
      pipe.transform({ isActive: false }, { type: "body", metatype: bodyType() }),
    ).resolves.toMatchObject({ isActive: false });
  });

  const line = { productId: "p1", qty: 1 };
  const lines = (n: number) => Array.from({ length: n }, () => ({ ...line }));
  it.each([
    ["create", CreateOrderTemplateDto, { name: "W", daysOfWeek: [1] }],
    ["update", UpdateOrderTemplateDto, {}],
  ])("(h) %s caps template lines at 500: 501 refused, 500 accepted", async (_n, type, base) => {
    const opts = { type: "body" as const, metatype: type as never };
    await expect(pipe.transform({ ...base, items: lines(501) }, opts)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(pipe.transform({ ...base, items: lines(500) }, opts)).resolves.toBeDefined();
  });

  it.each([-3, 0, Number.NaN])(
    "(d) a stored line with quantity %s is refused on a run: nothing is ordered and no stock moves",
    async (qty) => {
      setup([{ id: "p-active", isActive: true }]);
      tpl.items[0].qty = qty;
      const run = service.generateOrder("t1", false, false);
      await expect(run).rejects.toThrow(ZERO_MSG);
      await expect(run).rejects.toMatchObject({ status: 400 });
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(decrementStockForSale).not.toHaveBeenCalled();
    },
  );

  it("(e) control: a positive stored quantity still orders", async () => {
    setup([{ id: "p-active", isActive: true }]);
    await service.generateOrder("t1", false, false);
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
  });

  it("(f) create() refuses a non-positive line quantity before any write", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1, deletedAt: null });
    prisma.product.findMany.mockResolvedValue([product("p1", true)]);
    await expect(
      service.create({
        customerId: "c1",
        name: "Weekly",
        daysOfWeek: [1],
        items: [{ productId: "p1", qty: -2 }],
      } as never),
    ).rejects.toThrow(ZERO_MSG);
    expect(prisma.orderTemplate.create).not.toHaveBeenCalled();
  });

  it("(g) update() with a non-positive line quantity is refused before any write", async () => {
    setup([{ id: "p1", isActive: true }]);
    await expect(
      service.update("t1", { items: [{ productId: "p1", qty: 0 }] } as never, {
        role: "OPERATOR",
        userId: "u1",
      }),
    ).rejects.toThrow(ZERO_MSG);
    expect(prisma.orderTemplate.update).not.toHaveBeenCalled();
  });
});
