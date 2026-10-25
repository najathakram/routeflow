jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

/**
 * Row 510 (ruling Q2) — a standing order's MANUAL run by a staff member is the warning dialog for the clicker:
 *  - `generateOrderForUser` (POST /order-templates/:id/generate) takes the optional body ack
 *    `{ restrictionOverrides, warningHash }`; the choke point is asked as STAFF with THAT user as the principal, the
 *    ack, `document: "ORDER"` and `n:<index>` line keys;
 *  - breaches answer 409 RESTRICTION_WARNING (nothing written); with a valid ack the order is created and the decision
 *    is STAMPED inside the order's own transaction, by the clicker;
 *  - a PICKUP customer's standing order is judged at the STORE (kind PICKUP, sale-fulfilment.ts);
 *  - a buyer's Reorder (CUSTOMER) keeps the hard BUYER_PORTAL 409 and never carries an actor or an ack;
 *  - the SCHEDULED 06:00 run never asks for an acknowledgement and never stamps: it follows #2093 (skip the banned line,
 *    order the rest, notify once, suspend the template line), and a template line carries no override forward.
 */
import { RegulatedVisibilityService } from "../buyer/regulated-visibility.service";
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
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
import type { JwtPayload } from "../auth/jwt-payload.interface";

const operator = { sub: "u-op", role: "OPERATOR", tenantId: "test-tenant" } as JwtPayload;
const buyer = { sub: "u-buyer", role: "CUSTOMER", tenantId: "test-tenant" } as JwtPayload;
const ack = {
  warningHash: "rw1:abc",
  restrictionOverrides: [{ lineKey: "n:0", reason: "Licensed buyer" }],
};
const warning = () =>
  new ConflictException({
    code: "RESTRICTION_WARNING",
    message: "This sale includes a restricted product. Give a reason to sell it anyway.",
    lines: [{ lineKey: "n:0", productId: "p-banned" }],
    warningHash: "rw1:abc",
  });

describe("OrderTemplatesService — a manual STAFF run warns and takes the ack (row 510)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const decision = { stamp: jest.fn() };
  const restrictions = { assertLinesSellable: jest.fn(), checkLinesSellable: jest.fn() };
  const notifications = { sendToCustomer: jest.fn(), sendToUser: jest.fn() };
  const audit = { log: jest.fn() };
  const authGuard = { checkAuthorized: jest.fn() };
  const ordersService = {
    mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
    loadActivePromotions: jest.fn(),
    getCustomerPriceHistory: jest.fn(),
    resolveBuyerLinePrice: jest.fn((...args: any[]) =>
      (OrdersService.prototype as any).resolveBuyerLinePrice(...args),
    ),
  };
  const line = (productId: string) => ({ productId, qty: 2, notes: null });
  const template = (over: object = {}) => ({
    id: "t1",
    customerId: "c1",
    name: "Weekly",
    isActive: true,
    createdByRole: "OPERATOR",
    itemsEditedByRole: "OPERATOR",
    items: [line("p-banned"), line("p-ok")],
    ...over,
  });
  const block = {
    outcome: "BLOCK",
    reasons: [{ productId: "p-banned", productName: "Banned Cola", ruleId: "rule-1" }],
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue("test-tenant");
    decision.stamp.mockResolvedValue(1);
    restrictions.assertLinesSellable.mockResolvedValue(decision);
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
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_i, fn) => fn()) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: ordersService },
        { provide: AuthorizationGuardService, useValue: authGuard },
        { provide: NotificationsService, useValue: notifications },
        { provide: SellingRestrictionsService, useValue: restrictions },
        { provide: AuditService, useValue: audit },
        // master's regulated-category gate (a constructor dependency): nothing locked here
        {
          provide: RegulatedVisibilityService,
          useValue: { computeGate: jest.fn(async () => ({ hiddenIds: new Set(), locked: [] })) },
        },
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

  it("asks the choke point as STAFF with the clicker as principal, the ack, the ORDER target and n:<index> keys", async () => {
    await service.generateOrderForUser("t1", operator, ack);
    expect(restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
    expect(restrictions.assertLinesSellable).toHaveBeenCalledWith({
      tenantId: "test-tenant",
      customerId: "c1",
      lines: [
        { productId: "p-banned", lineKey: "n:0" },
        { productId: "p-ok", lineKey: "n:1" },
      ],
      fulfilmentKind: "DELIVERY",
      principal: operator,
      ack,
      document: "ORDER",
      channel: "STAFF",
    });
  });

  it("a breach answers 409 RESTRICTION_WARNING and writes nothing (no order, no stamp, no suspension)", async () => {
    restrictions.assertLinesSellable.mockRejectedValue(warning());
    await expect(service.generateOrderForUser("t1", operator)).rejects.toMatchObject({
      response: { code: "RESTRICTION_WARNING", warningHash: "rw1:abc" },
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(decision.stamp).not.toHaveBeenCalled();
    expect(prisma.orderTemplateItem.updateMany).not.toHaveBeenCalled();
    expect(notifications.sendToCustomer).not.toHaveBeenCalled();
  });

  it("with a valid ack the order is created and the decision is stamped inside the order's transaction, once", async () => {
    await service.generateOrderForUser("t1", operator, ack);
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    expect(decision.stamp).toHaveBeenCalledTimes(1);
    const [tx, orderId] = decision.stamp.mock.calls[0];
    expect(orderId).toBe("o1");
    expect(tx).toBeDefined();
    // the stamp comes after the order row exists and before the transaction returns
    expect(prisma.order.create.mock.invocationCallOrder[0]).toBeLessThan(
      decision.stamp.mock.invocationCallOrder[0],
    );
    // the template line itself is untouched: nothing is carried forward onto it
    expect(prisma.orderTemplateItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.orderTemplate.update).not.toHaveBeenCalled();
  });

  it("a PICKUP customer's standing order is judged at the STORE (fulfilmentKind PICKUP)", async () => {
    prisma.customer.findFirst.mockResolvedValue({ fulfillPath: "PICKUP" });
    await service.generateOrderForUser("t1", operator, ack);
    expect(restrictions.assertLinesSellable.mock.calls[0][0].fulfilmentKind).toBe("PICKUP");
  });

  it("a SHIP customer's standing order is judged at the customer's address (a SHIP customer is a DELIVERY kind)", async () => {
    prisma.customer.findFirst.mockResolvedValue({ fulfillPath: "SHIP" });
    await service.generateOrderForUser("t1", operator);
    expect(restrictions.assertLinesSellable.mock.calls[0][0].fulfilmentKind).toBe("DELIVERY");
  });

  it("a buyer's Reorder keeps the BUYER_PORTAL channel and carries NO actor and NO ack, even if the body sent one", async () => {
    prisma.customer.findFirst.mockResolvedValueOnce({ id: "c1" }); // the ownership check: this buyer's own template
    await service.generateOrderForUser("t1", buyer, ack);
    const call = restrictions.assertLinesSellable.mock.calls[0][0];
    expect(call.channel).toBe("BUYER_PORTAL");
    expect(call.principal).toBeUndefined();
    expect(call.ack).toBeUndefined();
  });

  it("the SCHEDULED run never asks for or applies an acknowledgement and never stamps: skip, order the rest, notify once, suspend", async () => {
    restrictions.checkLinesSellable.mockResolvedValue(block);
    prisma.tenant.findMany.mockResolvedValue([{ id: "tn-1" }]);
    prisma.orderTemplate.findMany.mockResolvedValue([template()]);
    prisma.orderTemplate.count.mockResolvedValue(0);
    prisma.order.findFirst.mockResolvedValue(null);
    await service.generateDailyOrders();
    // the banned line is skipped, the rest is ordered, the template line is suspended, staff are told once
    const lines = prisma.order.create.mock.calls[0][0].data.lineItems.create;
    expect(lines.map((l: any) => l.productId)).toEqual(["p-ok"]);
    expect(prisma.orderTemplateItem.updateMany).toHaveBeenCalledWith({
      where: { templateId: "t1", productId: { in: ["p-banned"] } },
      data: { suspendedAt: expect.any(Date), suspendedReason: "SELLING_RESTRICTED" },
    });
    expect(notifications.sendToUser).toHaveBeenCalledTimes(1);
    // no acknowledgement path at all
    expect(restrictions.assertLinesSellable).not.toHaveBeenCalled();
    expect(decision.stamp).not.toHaveBeenCalled();
    expect(JSON.stringify(lines)).not.toMatch(/restrictionOverride/);
  });

  it("the scheduled run judges a PICKUP customer at the store too (the same path rule)", async () => {
    prisma.customer.findFirst.mockResolvedValue({ fulfillPath: "PICKUP" });
    prisma.tenant.findMany.mockResolvedValue([{ id: "tn-1" }]);
    prisma.orderTemplate.findMany.mockResolvedValue([template()]);
    prisma.orderTemplate.count.mockResolvedValue(0);
    prisma.order.findFirst.mockResolvedValue(null);
    await service.generateDailyOrders();
    expect(restrictions.checkLinesSellable.mock.calls[0][0].fulfilmentKind).toBe("PICKUP");
  });
});
