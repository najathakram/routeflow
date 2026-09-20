import { Test } from "@nestjs/testing";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { RestrictionsEvaluation } from "@routeflow/types";
import { OrderTemplatesService } from "./order-templates.service";
import { splitRestrictedLines } from "./template-restrictions";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * Lane R: a standing order is skip-and-notify for selling restrictions (plan §3 #6), like the
 * regulated license guard — a banned line is dropped and the rest is still ordered; a fully
 * restricted template orders nothing and is never a hard failure of the cron run.
 */
const evaluation = (
  outcome: RestrictionsEvaluation["outcome"],
  productIds: string[] = [],
): RestrictionsEvaluation => ({
  outcome,
  reasons: productIds.map((productId) => ({
    productId,
    productName: `Name of ${productId}`,
    ruleId: "r1",
    reason: outcome === "INDETERMINATE" ? "INDETERMINATE_ADDRESS" : "STATE_BAN",
    message: "detail that must never reach the buyer",
  })),
});

describe("OrderTemplatesService — selling restrictions on a standing order", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let restrictions: { checkLinesSellable: jest.Mock };
  let authGuard: { checkAuthorized: jest.Mock };
  let notifications: { sendToCustomer: jest.Mock; sendToUser: jest.Mock };

  const template = {
    id: "t1",
    customerId: "c1",
    name: "Weekly",
    isActive: true,
    items: [
      { productId: "p-ban", qty: 2, notes: null },
      { productId: "p-ok", qty: 3, notes: null },
    ],
  };
  const products = [
    { id: "p-ban", pricePerUnit: 10, trackedCategoryId: null },
    { id: "p-ok", pricePerUnit: 5, trackedCategoryId: null },
  ];

  beforeEach(async () => {
    prisma = createMockPrisma();
    restrictions = { checkLinesSellable: jest.fn().mockResolvedValue(evaluation("ALLOW")) };
    authGuard = { checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }) };
    notifications = {
      sendToCustomer: jest.fn().mockResolvedValue(1),
      sendToUser: jest.fn().mockResolvedValue(1),
    };
    const ordersService = {
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
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: ordersService },
        { provide: AuthorizationGuardService, useValue: authGuard },
        { provide: NotificationsService, useValue: notifications },
        { provide: SellingRestrictionsService, useValue: restrictions },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);

    prisma.orderTemplate.findUnique.mockResolvedValue(template);
    prisma.product.findMany.mockResolvedValue(products);
    prisma.order.create.mockImplementation((a: any) => Promise.resolve({ id: "o1", ...a.data }));
    prisma.user.findMany.mockResolvedValue([{ id: "op1" }]);
  });

  const createdLines = () => prisma.order.create.mock.calls[0][0].data.lineItems.create;

  it("asks the choke point once for every line, as the customer on the BUYER_PORTAL channel", async () => {
    await service.generateOrder("t1");
    expect(restrictions.checkLinesSellable).toHaveBeenCalledTimes(1);
    expect(restrictions.checkLinesSellable).toHaveBeenCalledWith({
      tenantId: "test-tenant",
      customerId: "c1",
      lines: [{ productId: "p-ban" }, { productId: "p-ok" }],
      channel: "BUYER_PORTAL",
    });
    expect(createdLines()).toHaveLength(2);
    expect(notifications.sendToCustomer).not.toHaveBeenCalled();
  });

  it("OFF orders every line and notifies nobody", async () => {
    restrictions.checkLinesSellable.mockResolvedValue(evaluation("OFF"));
    await service.generateOrder("t1");
    expect(createdLines()).toHaveLength(2);
    expect(notifications.sendToUser).not.toHaveBeenCalled();
  });

  it.each(["BLOCK", "INDETERMINATE"] as const)(
    "%s drops only the named line, orders the rest, and tells the buyer without the rule detail",
    async (outcome) => {
      restrictions.checkLinesSellable.mockResolvedValue(evaluation(outcome, ["p-ban"]));
      await service.generateOrder("t1");

      const data = prisma.order.create.mock.calls[0][0].data;
      expect(createdLines().map((l: any) => l.productId)).toEqual(["p-ok"]);
      expect(data.subtotal).toBe(15); // 5 × 3 only — the banned line is not billed
      expect(data.notes).toContain("skipped — restricted");

      const [, , buyerBody] = notifications.sendToCustomer.mock.calls[0];
      expect(buyerBody).toContain("1 line(s)");
      expect(buyerBody).not.toContain("Name of p-ban");
      expect(buyerBody).not.toContain("detail that must never reach the buyer");
      expect(notifications.sendToUser).toHaveBeenCalledWith(
        "op1",
        expect.objectContaining({ body: expect.stringContaining("Name of p-ban") }),
      );
    },
  );

  it("every line restricted: nothing is created, the operator is told, the manual path says why", async () => {
    restrictions.checkLinesSellable.mockResolvedValue(evaluation("BLOCK", ["p-ban", "p-ok"]));
    await expect(service.generateOrder("t1")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(notifications.sendToUser).toHaveBeenCalled();
  });

  it("an outcome that names no product drops every line but is never silent", async () => {
    restrictions.checkLinesSellable.mockResolvedValue(evaluation("BLOCK", []));
    await expect(service.generateOrder("t1")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
    expect(notifications.sendToUser).toHaveBeenCalledTimes(1);
  });

  it("a notification failure never turns a skip into a failed run", async () => {
    restrictions.checkLinesSellable.mockResolvedValue(evaluation("BLOCK", ["p-ban"]));
    notifications.sendToCustomer.mockRejectedValue(new Error("push down"));
    notifications.sendToUser.mockRejectedValue(new Error("push down"));
    await expect(service.generateOrder("t1")).resolves.toMatchObject({ id: "o1" });
    expect(createdLines()).toHaveLength(1);
  });

  it("a session with no tenant fails closed before any write", async () => {
    prisma.getTenantId.mockReturnValue(null);
    await expect(service.generateOrder("t1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("does not ask the choke point when the license guard already left nothing to order", async () => {
    prisma.product.findMany.mockResolvedValue(
      products.map((p) => ({ ...p, trackedCategoryId: "cat-x" })),
    );
    authGuard.checkAuthorized.mockResolvedValue({
      blocked: [{ trackedCategoryId: "cat-x", categoryName: "X", reason: "NO_AUTH" }],
    });
    await expect(service.generateOrder("t1")).rejects.toBeInstanceOf(BadRequestException);
    expect(restrictions.checkLinesSellable).not.toHaveBeenCalled();
  });
});

describe("splitRestrictedLines", () => {
  const items = [{ productId: "a" }, { productId: "b" }, { productId: "a" }];

  it.each(["OFF", "ALLOW"] as const)("%s drops nothing", (outcome) => {
    expect(splitRestrictedLines(items, evaluation(outcome)).allowed).toEqual(items);
  });

  it("drops every line of a named product (duplicate lines included)", () => {
    const r = splitRestrictedLines(items, evaluation("BLOCK", ["a"]));
    expect(r.allowed).toEqual([{ productId: "b" }]);
    expect(r.blocked).toHaveLength(1);
  });

  it.each(["BLOCK", "INDETERMINATE"] as const)(
    "%s that names no product fails closed: every line dropped",
    (outcome) => {
      expect(splitRestrictedLines(items, evaluation(outcome, [])).allowed).toEqual([]);
    },
  );
});
