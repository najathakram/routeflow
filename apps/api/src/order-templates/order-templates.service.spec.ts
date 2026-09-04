import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { OrderTemplatesService } from "./order-templates.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * W6b follow-up: the standing-order (reorder) path used to write orders via a
 * direct prisma.order.create() that never ran the regulated-item license guard,
 * so a license-gated line could be sold to an unverified customer. These specs
 * pin the fix: blocked lines are SKIPPED (spec §8), the rest is ordered, both
 * sides are notified, and a fully-gated template yields nothing.
 */
describe("OrderTemplatesService — regulated license guard on reorder", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let authGuard: { checkAuthorized: jest.Mock };
  let notifications: { sendToCustomer: jest.Mock; sendToUser: jest.Mock };
  // REG-B48 widened createOrderFromTemplate's collaborator surface: it now prices every
  // line through the shared buyer resolver, so this guard suite has to mock the same
  // OrdersService methods the real module boundary exposes. `resolveBuyerLinePrice`
  // delegates to the REAL implementation (it uses no `this`) so the license-guard
  // assertions below still measure real money, not a stub's.
  let ordersService: {
    mergeAllPendingForCustomer: jest.Mock;
    loadActivePromotions: jest.Mock;
    getCustomerPriceHistory: jest.Mock;
    resolveBuyerLinePrice: jest.Mock;
  };

  const template = {
    id: "t1",
    customerId: "c1",
    name: "Weekly",
    isActive: true,
    items: [
      { productId: "p-tob", qty: 2, notes: null },
      { productId: "p-std", qty: 3, notes: null },
    ],
  };
  const products = [
    { id: "p-tob", pricePerUnit: 10, trackedCategoryId: "cat-tob" },
    { id: "p-std", pricePerUnit: 5, trackedCategoryId: null },
  ];

  beforeEach(async () => {
    prisma = createMockPrisma();
    authGuard = { checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }) };
    notifications = {
      sendToCustomer: jest.fn().mockResolvedValue(1),
      sendToUser: jest.fn().mockResolvedValue(1),
    };
    ordersService = {
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      loadActivePromotions: jest.fn().mockResolvedValue([]),
      getCustomerPriceHistory: jest.fn().mockResolvedValue({}),
      resolveBuyerLinePrice: jest.fn((...args: any[]) =>
        (OrdersService.prototype as any).resolveBuyerLinePrice(...args),
      ),
    };

    const mod = await Test.createTestingModule({
      providers: [
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
        // settings.taxRate is stored as a PERCENT string — "10" is 10%.
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue("10") },
        },
        { provide: OrdersService, useValue: ordersService },
        { provide: AuthorizationGuardService, useValue: authGuard },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);

    prisma.orderTemplate.findUnique.mockResolvedValue(template);
    prisma.product.findMany.mockResolvedValue(products);
    prisma.order.create.mockImplementation((a: any) => Promise.resolve({ id: "o1", ...a.data }));
    prisma.user.findMany.mockResolvedValue([{ id: "op1" }]);
  });

  it("runs the guard with the resolved per-line tracked category", async () => {
    await service.generateOrder("t1");
    expect(authGuard.checkAuthorized).toHaveBeenCalledWith({
      customerId: "c1",
      lines: [{ trackedCategoryId: "cat-tob" }, { trackedCategoryId: null }],
    });
  });

  it("skips the blocked regulated line, orders the rest, and notifies both sides", async () => {
    authGuard.checkAuthorized.mockResolvedValue({
      blocked: [{ trackedCategoryId: "cat-tob", categoryName: "Tobacco", reason: "NO_AUTH" }],
    });

    const order = await service.generateOrder("t1");

    const createArg = prisma.order.create.mock.calls[0][0];
    const createdLines = createArg.data.lineItems.create;
    expect(createdLines).toHaveLength(1);
    expect(createdLines[0].productId).toBe("p-std");
    expect(createArg.data.subtotal).toBe(15); // 5 * 3 only — tobacco excluded
    expect(createArg.data.notes).toContain("skipped");
    expect(notifications.sendToCustomer).toHaveBeenCalledWith(
      "c1",
      expect.any(String),
      expect.stringContaining("Tobacco"),
    );
    expect(notifications.sendToUser).toHaveBeenCalledWith(
      "op1",
      expect.objectContaining({ title: expect.stringContaining("skipped") }),
    );
    expect(order).toMatchObject({ id: "o1" });
  });

  it("orders every line (snapshotting the regulated category + hasRegulated) when verified", async () => {
    authGuard.checkAuthorized.mockResolvedValue({ blocked: [] });
    await service.generateOrder("t1");
    const createData = prisma.order.create.mock.calls[0][0].data;
    const createdLines = createData.lineItems.create;
    expect(createdLines).toHaveLength(2);
    // The allowed regulated line snapshots its tracked category so it invoices
    // as regulated (split + ledger) rather than standard.
    const tob = createdLines.find((l: any) => l.productId === "p-tob");
    expect(tob.trackedCategoryId).toBe("cat-tob");
    expect(createData.hasRegulated).toBe(true);
    expect(notifications.sendToCustomer).not.toHaveBeenCalled();
  });

  it("creates nothing and throws when EVERY line is a license-gated category", async () => {
    prisma.orderTemplate.findUnique.mockResolvedValue({
      ...template,
      items: [{ productId: "p-tob", qty: 1, notes: null }],
    });
    authGuard.checkAuthorized.mockResolvedValue({
      blocked: [{ trackedCategoryId: "cat-tob", categoryName: "Tobacco", reason: "EXPIRED" }],
    });

    await expect(service.generateOrder("t1")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(notifications.sendToCustomer).toHaveBeenCalled(); // still notified about the skip
  });

  // ─── PR-2 (imp-02): post-commit consolidation is deferred, never an error ───
  //
  // The invariant (orders/merge-contention.ts): the standing order has already
  // COMMITTED by the time mergeAllPendingForCustomer runs. Letting its 409 out
  // would report a placed order as a failure — on the 06:00 cron it lands in
  // generateDailyOrders' per-template catch and is logged as an ERROR while the
  // row exists; on the manual path it becomes the caller's response.

  it("asks for the merge lock with lockMode 'try' — a post-commit consolidation never waits", async () => {
    authGuard.checkAuthorized.mockResolvedValue({ blocked: [] });

    await service.generateOrder("t1");

    // Third argument, not second: `{ buyerInitiated }` keeps its slot. On the 06:00 cron this
    // runs once per template, so waiting 20s per contended customer would stretch the run
    // without changing the outcome — the hourly sweep folds whatever is left.
    expect(ordersService.mergeAllPendingForCustomer).toHaveBeenCalledWith(
      "c1",
      expect.any(Object),
      { lockMode: "try" },
    );
  });

  it("returns the created order when the post-commit consolidation hits merge-lock contention", async () => {
    authGuard.checkAuthorized.mockResolvedValue({ blocked: [] });
    ordersService.mergeAllPendingForCustomer.mockRejectedValue(
      new ConflictException({
        code: "MERGE_IN_PROGRESS",
        message: "Another merge for this customer is in progress — retry.",
      }),
    );
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    const order = await service.generateOrder("t1");

    // The row that WAS written comes back — unconsolidated, which the hourly
    // sweep fixes. Before the fix this rejected with the 409.
    expect(order).toMatchObject({ id: "o1" });
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("c1");
  });

  it("still propagates a non-contention failure from the post-commit consolidation", async () => {
    authGuard.checkAuthorized.mockResolvedValue({ blocked: [] });
    ordersService.mergeAllPendingForCustomer.mockRejectedValue(new Error("boom"));
    jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    // The swallow is by CODE: a real merge fault must not be hidden behind a warning.
    await expect(service.generateOrder("t1")).rejects.toThrow("boom");
  });
});

/**
 * SECURITY regression (F2-003): the customer-reachable item-removal and
 * order-generation endpoints route through removeItemForUser /
 * generateOrderForUser, whose findOneForUser() ownership check must reject a
 * CUSTOMER operating on ANOTHER customer's template. Before the fix, any
 * CUSTOMER could strip items from or generate orders off any tenant's template.
 */
describe("OrderTemplatesService — template ownership (F2-003)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const template = {
    id: "t1",
    customerId: "c-owner",
    name: "Weekly",
    isActive: true,
    items: [{ id: "i1", productId: "p1", qty: 1, notes: null }],
    customer: { id: "c-owner", businessName: "Owner Cafe" },
  };
  const asCustomer = (sub: string) => ({ sub, role: "CUSTOMER" }) as any;
  const asOperator = { sub: "op-1", role: "OPERATOR" } as any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
        // settings.taxRate is stored as a PERCENT string — "10" is 10%.
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue("10") },
        },
        { provide: OrdersService, useValue: { mergeAllPendingForCustomer: jest.fn() } },
        {
          provide: AuthorizationGuardService,
          useValue: { checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }) },
        },
        {
          provide: NotificationsService,
          useValue: { sendToCustomer: jest.fn(), sendToUser: jest.fn() },
        },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);

    prisma.orderTemplate.findUnique.mockResolvedValue(template);
    prisma.orderTemplateItem.findFirst.mockResolvedValue(template.items[0]);
    prisma.orderTemplateItem.delete.mockResolvedValue(template.items[0]);
    prisma.product.findMany.mockResolvedValue([{ id: "p1", pricePerUnit: 5 }]);
    prisma.order.create.mockImplementation((a: any) => Promise.resolve({ id: "o1", ...a.data }));
    prisma.user.findMany.mockResolvedValue([]);
  });

  it("a CUSTOMER who does not own the template cannot remove its items", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "c-attacker" });

    await expect(service.removeItemForUser("t1", "i1", asCustomer("u-attacker"))).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.orderTemplateItem.delete).not.toHaveBeenCalled();
  });

  it("a CUSTOMER who does not own the template cannot generate orders from it", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "c-attacker" });

    await expect(service.generateOrderForUser("t1", asCustomer("u-attacker"))).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("a CUSTOMER JWT with no customer record in this tenant is rejected", async () => {
    prisma.customer.findFirst.mockResolvedValue(null); // cross-tenant token

    await expect(service.removeItemForUser("t1", "i1", asCustomer("u-foreign"))).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.orderTemplateItem.delete).not.toHaveBeenCalled();
  });

  it("the OWNING customer can still remove items", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "c-owner" });

    const result = await service.removeItemForUser("t1", "i1", asCustomer("u-owner"));
    expect(result).toEqual({ success: true });
    expect(prisma.orderTemplateItem.delete).toHaveBeenCalledWith({ where: { id: "i1" } });
  });

  it("an OPERATOR bypasses the ownership check (staff manage all templates)", async () => {
    const result = await service.removeItemForUser("t1", "i1", asOperator);
    expect(result).toEqual({ success: true });
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  // T11 (REG-B133): addItem() (unlike removeItemForUser/generateOrderForUser)
  // took no user at all, so ANY authenticated customer could add items to
  // ANY tenant's template. addItemForUser must apply the same ownership check
  // as its siblings above. addItemForUser does not exist at 39632d27 — the
  // bare call throws synchronously before a chained .catch() can attach, so
  // the call is deferred inside a resolved-promise chain to keep the failure
  // an assertion (toBeInstanceOf) instead of an unhandled exception.
  //
  // Each of the three tests below opens with an explicit existence assertion so
  // the pre-fix red NAMES the missing wrapper instead of surfacing as an opaque
  // "expected ForbiddenException, received TypeError". Once R6 lands the line is
  // a no-op and the ownership assertions below it carry the proof.
  it("REG-B133 a CUSTOMER who does not own the template cannot add items to it", async () => {
    expect(typeof (service as any).addItemForUser).toBe("function");
    prisma.customer.findFirst.mockResolvedValue({ id: "c-attacker" });
    prisma.product.findUnique.mockResolvedValue({ id: "p1" });

    const err = await Promise.resolve()
      .then(() =>
        (service as any).addItemForUser(
          "t1",
          { productId: "p1", qty: 1 },
          asCustomer("u-attacker"),
        ),
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect(prisma.orderTemplateItem.create).not.toHaveBeenCalled();
  });

  it("REG-B133 a CUSTOMER JWT with no customer record cannot add items (cross-tenant token)", async () => {
    expect(typeof (service as any).addItemForUser).toBe("function");
    prisma.customer.findFirst.mockResolvedValue(null);

    const err = await Promise.resolve()
      .then(() =>
        (service as any).addItemForUser("t1", { productId: "p1", qty: 1 }, asCustomer("u-foreign")),
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect(prisma.orderTemplateItem.create).not.toHaveBeenCalled();
  });

  it("pin (B133): the owning customer and an operator add items; the operator path skips the ownership read", async () => {
    expect(typeof (service as any).addItemForUser).toBe("function");
    prisma.product.findUnique.mockResolvedValue({ id: "p1" });
    prisma.orderTemplateItem.create.mockResolvedValue({ id: "i2" });

    prisma.customer.findFirst.mockResolvedValue({ id: "c-owner" });
    await (service as any).addItemForUser("t1", { productId: "p1", qty: 1 }, asCustomer("u-owner"));
    expect(prisma.orderTemplateItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ templateId: "t1", productId: "p1", qty: 1 }),
      }),
    );

    prisma.customer.findFirst.mockClear();
    await (service as any).addItemForUser("t1", { productId: "p1", qty: 1 }, asOperator);
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
    expect(prisma.orderTemplateItem.create).toHaveBeenCalledTimes(2);
  });
});

/**
 * B48 (R10) pin: a tier-1 customer with no CustomerPrice override, no active
 * promotion and no remembered upsell price must land byte-identical to the
 * pre-fix behaviour — list price, STANDARD, no strikethrough.
 */
describe("OrderTemplatesService — pricing pin, tier 1 unchanged (T16)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ordersService: {
    mergeAllPendingForCustomer: jest.Mock;
    loadActivePromotions: jest.Mock;
    getCustomerPriceHistory: jest.Mock;
    resolveBuyerLinePrice: jest.Mock;
  };

  const realResolver = (OrdersService.prototype as any).resolveBuyerLinePrice;

  beforeEach(async () => {
    prisma = createMockPrisma();
    ordersService = {
      mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
      loadActivePromotions: jest.fn().mockResolvedValue([]),
      getCustomerPriceHistory: jest.fn().mockResolvedValue({}),
      resolveBuyerLinePrice: jest.fn((...args: any[]) => realResolver(...args)),
    };

    const mod = await Test.createTestingModule({
      providers: [
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: ordersService },
        {
          provide: AuthorizationGuardService,
          useValue: { checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }) },
        },
        {
          provide: NotificationsService,
          useValue: { sendToCustomer: jest.fn(), sendToUser: jest.fn() },
        },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);

    prisma.customer.findUnique.mockResolvedValue({ id: "c1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.order.create.mockImplementation((a: any) => Promise.resolve({ id: "o1", ...a.data }));
    prisma.orderTemplate.findUnique.mockResolvedValue({
      id: "t1",
      customerId: "c1",
      name: "Weekly",
      isActive: true,
      items: [{ productId: "p1", qty: 2, notes: null }],
    });
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", pricePerUnit: 10, unitsPerBox: null, category: null, trackedCategoryId: null },
    ]);
  });

  // Only the money half is a genuine pin: today's created line carries no `priceType`
  // or `originalPrice` key at all, so asserting those here would be a post-fix
  // expectation wearing a pin's clothes. They are proven instead by the tokened
  // red test in order-templates.pricing-and-items.spec.ts (T16).
  it("pin (T16): tier 1, no override/promo/history -> list price and subtotal unchanged", async () => {
    await service.generateOrder("t1");
    const line = prisma.order.create.mock.calls[0][0].data.lineItems.create[0];
    expect(line).toMatchObject({ unitPrice: 10, subtotal: 20 });
  });
});

/**
 * B48 (R23) pin: a PATCH that names no `items` key must leave item
 * replacement completely untouched — no deleteMany, no transaction.
 */
describe("OrderTemplatesService — update() with no items key (T27)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: { mergeAllPendingForCustomer: jest.fn() } },
        {
          provide: AuthorizationGuardService,
          useValue: { checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }) },
        },
        {
          provide: NotificationsService,
          useValue: { sendToCustomer: jest.fn(), sendToUser: jest.fn() },
        },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);

    prisma.orderTemplate.findUnique.mockResolvedValue({
      id: "t1",
      customerId: "c1",
      name: "Weekly",
      isActive: true,
      items: [],
    });
    prisma.orderTemplate.update.mockImplementation((a: any) =>
      Promise.resolve({ id: "t1", ...a.data }),
    );
  });

  it("pin (T27): a PATCH with no items key leaves item replacement untouched", async () => {
    await service.update("t1", { name: "n" } as any);

    expect(prisma.orderTemplateItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.orderTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t1" },
        data: expect.objectContaining({ name: "n" }),
      }),
    );
  });
});
