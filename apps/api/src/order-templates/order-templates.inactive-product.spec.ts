import { regulatedGateOpenProvider } from "./testing/regulated-gate-open-provider";
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
  const auditActions = () =>
    prisma.auditLog.create.mock.calls.map((c: any) => [c[0].data.action, c[0].data.meta]);

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

  it("sends no notice when nothing was skipped", async () => {
    setup([{ id: "p-active", isActive: true }]);

    await service.generateOrder("t1", false, false);

    expect(notifications.sendToCustomer).not.toHaveBeenCalled();
    expect(notifications.sendToUser).not.toHaveBeenCalled();
  });

  it("sends no notice when the run then fails — nobody is told about an order that was never placed", async () => {
    setup([
      { id: "p-active", isActive: true },
      { id: "p-gone", isActive: false },
    ]);
    prisma.order.create.mockRejectedValue(new Error("oversell"));

    await expect(service.generateOrder("t1", false, false)).rejects.toThrow("oversell");

    expect(notifications.sendToCustomer).not.toHaveBeenCalled();
    expect(notifications.sendToUser).not.toHaveBeenCalled();
  });

  it("sends the notice only once the order is placed", async () => {
    setup([
      { id: "p-active", isActive: true },
      { id: "p-gone", isActive: false },
    ]);

    await service.generateOrder("t1", false, false);

    const created = prisma.order.create.mock.invocationCallOrder[0];
    expect(notifications.sendToCustomer.mock.invocationCallOrder[0]).toBeGreaterThan(created);
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

  // ─── SA-638: suspend once, notify once ──────────────────────────────────────────

  it("two consecutive runs send ONE customer notice and ONE operator notice", async () => {
    setup([
      { id: "p-active", isActive: true },
      { id: "p-gone", isActive: false },
    ]);

    await service.generateOrder("t1", false, false);
    prisma.order.create.mockClear();
    await service.generateOrder("t1", false, false);

    // the second run still orders the active line, but the suspended one is no longer re-announced
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
    expect(notifications.sendToUser).toHaveBeenCalledTimes(1);
  });

  it("suspends the deactivated line with reason PRODUCT_INACTIVE and an audit row", async () => {
    setup([
      { id: "p-active", isActive: true },
      { id: "p-gone", isActive: false },
    ]);

    await service.generateOrder("t1", false, false);

    const gone = tpl.items.find((i: any) => i.productId === "p-gone");
    expect(gone.suspendedReason).toBe("PRODUCT_INACTIVE");
    expect(gone.suspendedAt).toBeInstanceOf(Date);
    expect(tpl.items.find((i: any) => i.productId === "p-active").suspendedAt).toBeNull();
    expect(auditActions()).toContainEqual([
      "order-template.line-suspended",
      { reason: "PRODUCT_INACTIVE", productIds: ["p-gone"] },
    ]);
  });

  it("lifting the suspension after the product is reactivated orders the line again", async () => {
    setup([
      { id: "p-active", isActive: true },
      { id: "p-gone", isActive: false },
    ]);
    await service.generateOrder("t1", false, false);

    // the operator reactivates the product, then lifts the line
    prisma.product.findMany.mockResolvedValue([product("p-active", true), product("p-gone", true)]);
    await service.liftItemSuspension("t1", "i1", { sub: "op1" } as any);
    prisma.order.create.mockClear();
    await service.generateOrder("t1", false, false);

    expect(orderedProductIds()).toEqual(["p-active", "p-gone"]);
  });

  it("a failing run suspends nothing (the suspension follows the commit like the notice)", async () => {
    setup([
      { id: "p-active", isActive: true },
      { id: "p-gone", isActive: false },
    ]);
    prisma.order.create.mockRejectedValue(new Error("oversell"));

    await expect(service.generateOrder("t1", false, false)).rejects.toThrow("oversell");

    expect(tpl.items.every((i: any) => i.suspendedAt === null)).toBe(true);
  });

  it("unattended with every line deactivated: suspends, deactivates the template once, notifies once", async () => {
    setup([{ id: "p-gone", isActive: false }]);
    const template = await prisma.orderTemplate.findUnique();
    const ctx = { ban: null };

    await (service as any).createOrderFromTemplate(template, true, true, ctx);

    expect(tpl.isActive).toBe(false);
    expect(tpl.items[0].suspendedReason).toBe("PRODUCT_INACTIVE");
    expect(auditActions()).toContainEqual([
      "order-template.deactivated",
      { reason: "NO_ACTIVE_PRODUCTS" },
    ]);
    expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
    expect(notifications.sendToUser).toHaveBeenCalledTimes(1);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("a manual run with every line deactivated is still a 400 and changes nothing", async () => {
    setup([{ id: "p-gone", isActive: false }]);

    await expect(service.generateOrder("t1", false, false)).rejects.toThrow(BadRequestException);

    expect(tpl.isActive).toBe(true);
    expect(tpl.items[0].suspendedAt).toBeNull();
    expect(notifications.sendToCustomer).not.toHaveBeenCalled();
  });

  // ─── Opus review of #3110: one honest notice, and no double notice on a race ────────────────

  it("a banned line plus all-inactive lines gives ONE notice, and it says DEACTIVATED", async () => {
    setup([
      { id: "p-banned", isActive: true },
      { id: "p-gone", isActive: false },
    ]);
    checkLinesSellable.mockResolvedValue({
      outcome: "BLOCK",
      reasons: [{ productId: "p-banned", productName: "Banned Cola", ruleId: "r1" }],
    });
    const template = await prisma.orderTemplate.findUnique();
    const ctx: { ban: { count: number; names: string } | null } = { ban: null };

    await (service as any).createOrderFromTemplate(template, true, true, ctx);

    expect(tpl.isActive).toBe(false);
    expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
    expect(notifications.sendToUser).toHaveBeenCalledTimes(1);
    expect(notifications.sendToCustomer.mock.calls[0][2]).toMatch(/not sent/i);
    expect(notifications.sendToUser.mock.calls[0][1].body).toMatch(/deactivated/i);
    expect(notifications.sendToUser.mock.calls[0][1].body).toMatch(/Banned Cola/);
    // the cron's `finally` must not send a SECOND notice ("still active") for the ban
    expect(ctx.ban).toBeNull();
  });

  it("an all-inactive deactivation tells the operator how to bring the standing order back", async () => {
    setup([{ id: "p-gone", isActive: false }]);
    const template = await prisma.orderTemplate.findUnique();

    await (service as any).createOrderFromTemplate(template, true, true, { ban: null });

    const body = notifications.sendToUser.mock.calls[0][1].body;
    expect(body).toMatch(/deactivated/i);
    expect(body).toMatch(/reactivate/i);
    expect(body).not.toMatch(/edit the template/i);
  });

  it("a stale concurrent run that loses the suspension race audits and notifies nothing", async () => {
    setup([
      { id: "p-active", isActive: true },
      { id: "p-gone", isActive: false },
    ]);
    // both the 06:00 cron and a manual Reorder read the template BEFORE either suspended the line
    const stale = await prisma.orderTemplate.findUnique();

    await (service as any).createOrderFromTemplate(stale, true, true, { ban: null });
    notifications.sendToCustomer.mockClear();
    notifications.sendToUser.mockClear();
    prisma.auditLog.create.mockClear();
    await (service as any).createOrderFromTemplate(stale, true, true, { ban: null });

    expect(notifications.sendToCustomer).not.toHaveBeenCalled();
    expect(notifications.sendToUser).not.toHaveBeenCalled();
    expect(
      auditActions().filter(([a]: [string]) => a === "order-template.line-suspended"),
    ).toHaveLength(0);
  });
});
