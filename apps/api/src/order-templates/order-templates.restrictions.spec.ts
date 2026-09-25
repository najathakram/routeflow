/**
 * F-05 (#2093, owner rulings 2026-09-25, SA-205/SA-210) — a standing order SELLS its lines.
 *  - a MANUAL run (Generate now / Reorder) is refused with the 409 (the operator decides);
 *  - the UNATTENDED run skips the banned line(s), orders the rest, notifies once and suspends THAT template
 *    line (an AuditLog row); an all-banned or all-suspended template orders nothing, still with a notice;
 *  - the run's channel follows the template's snapshotted creator through the live predicate, and unknown
 *    provenance (NULL) is the STRICTER buyer channel, never staff;
 *  - an edit keeps a line's suspension unless THAT line's product or qty changed (audited lift); an explicit
 *    lift is its own audited action.
 * The choke point itself is proven in `selling-restrictions.service.spec.ts`.
 */
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
import { createMockPrisma } from "../testing/prisma-mock";

describe("OrderTemplatesService — selling restrictions (F-05)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const restrictions = { assertLinesSellable: jest.fn(), checkLinesSellable: jest.fn() };
  const notifications = { sendToCustomer: jest.fn(), sendToUser: jest.fn() };
  const audit = { log: jest.fn() };
  const ordersService = {
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
  const run = (t: object) => (service as any).createOrderFromTemplate(t, true, true);

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue("test-tenant");
    restrictions.assertLinesSellable.mockResolvedValue(undefined);
    restrictions.checkLinesSellable.mockResolvedValue({ outcome: "ALLOW", reasons: [] });
    notifications.sendToCustomer.mockResolvedValue(1);
    notifications.sendToUser.mockResolvedValue(1);
    audit.log.mockResolvedValue(undefined);
    ordersService.loadActivePromotions.mockResolvedValue([]);
    ordersService.getCustomerPriceHistory.mockResolvedValue({});
    const mod = await Test.createTestingModule({
      providers: [
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_i, fn) => fn()) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: ordersService },
        {
          provide: AuthorizationGuardService,
          useValue: { checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }) },
        },
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

  describe("manual run", () => {
    it("is refused with the 409 as STAFF (BUYER_PORTAL for a buyer), nothing written", async () => {
      restrictions.assertLinesSellable.mockRejectedValue(
        new ConflictException({ code: "SELLING_RESTRICTED", message: "banned", blockedLines: [] }),
      );
      await expect(service.generateOrder("t1")).rejects.toMatchObject({
        response: { code: "SELLING_RESTRICTED" },
      });
      await expect(service.generateOrder("t1", false)).rejects.toBeDefined();
      expect(restrictions.assertLinesSellable).toHaveBeenNthCalledWith(1, {
        tenantId: "test-tenant",
        customerId: "c1",
        lines: [{ productId: "p-banned" }, { productId: "p-ok" }],
        channel: "STAFF",
      });
      expect(restrictions.assertLinesSellable).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ channel: "BUYER_PORTAL" }),
      );
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(prisma.orderTemplateItem.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("unattended run", () => {
    it("a mixed template orders only the allowed line, notifies once and suspends the banned line (audited)", async () => {
      restrictions.checkLinesSellable.mockResolvedValue(block);
      await run(template());
      const lines = prisma.order.create.mock.calls[0][0].data.lineItems.create;
      expect(lines.map((l: any) => l.productId)).toEqual(["p-ok"]);
      expect(prisma.orderTemplateItem.updateMany).toHaveBeenCalledWith({
        where: { templateId: "t1", productId: { in: ["p-banned"] } },
        data: { suspendedAt: expect.any(Date), suspendedReason: "SELLING_RESTRICTED" },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "order-template.line-suspended",
          entityId: "t1",
          meta: expect.objectContaining({ ruleIds: ["rule-1"], reason: "SELLING_RESTRICTED" }),
        }),
      );
      expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
      expect(notifications.sendToCustomer.mock.calls[0][2]).toContain("Banned Cola");
      expect(notifications.sendToUser).toHaveBeenCalledTimes(1);
    });

    it("an all-banned template orders nothing but still suspends and notifies", async () => {
      restrictions.checkLinesSellable.mockResolvedValue({
        outcome: "BLOCK",
        reasons: [
          { productId: "p-banned", productName: "Banned Cola", ruleId: "rule-1" },
          { productId: "p-ok", productName: "Also Banned", ruleId: "rule-1" },
        ],
      });
      expect(await run(template())).toBeNull();
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(prisma.orderTemplateItem.updateMany).toHaveBeenCalledTimes(1);
      expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
    });

    it("an already-suspended line is neither re-checked nor ordered, and is not re-notified", async () => {
      const t = template({ items: [line("p-banned", { suspendedAt: new Date() }), line("p-ok")] });
      await run(t);
      expect(restrictions.checkLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({ lines: [{ productId: "p-ok" }] }),
      );
      expect(prisma.order.create.mock.calls[0][0].data.lineItems.create).toHaveLength(1);
      expect(notifications.sendToCustomer).not.toHaveBeenCalled();
    });

    it("an all-suspended template is skipped WITH a notification, never an empty order", async () => {
      const t = template({ items: [line("p-banned", { suspendedAt: new Date() })] });
      expect(await run(t)).toBeNull();
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
      expect(notifications.sendToUser).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["CUSTOMER", "BUYER_PORTAL"],
      ["OPERATOR", "STAFF"],
      ["TENANT_ADMIN", "STAFF"],
      [null, "BUYER_PORTAL"], // unknown provenance is the STRICTER channel, never staff
    ])("channel: a template created by %s is evaluated as %s", async (createdByRole, channel) => {
      await run(template({ createdByRole }));
      expect(restrictions.checkLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({ channel }),
      );
    });
  });

  describe("provenance on create", () => {
    it("snapshots the creator's role and id; an internal caller leaves it NULL", async () => {
      prisma.customer.findUnique.mockResolvedValue({ id: "c1" });
      prisma.product.findMany.mockResolvedValue([{ id: "p-ok" }]);
      prisma.orderTemplate.create.mockResolvedValue({ id: "t9" });
      const dto = { customerId: "c1", name: "N", daysOfWeek: [1], items: [line("p-ok")] } as never;
      await service.create(dto, { role: "OPERATOR", userId: "u1" });
      await service.create(dto);
      expect(prisma.orderTemplate.create.mock.calls[0][0].data).toMatchObject({
        createdByRole: "OPERATOR",
        createdByUserId: "u1",
      });
      expect(prisma.orderTemplate.create.mock.calls[1][0].data).toMatchObject({
        createdByRole: null,
        createdByUserId: null,
      });
    });
  });

  describe("edit and lift", () => {
    const when = new Date("2026-09-25T00:00:00Z");
    const editWith = async (items: { productId: string; qty: number }[]) => {
      prisma.orderTemplate.findUnique.mockResolvedValue(template());
      prisma.product.findMany.mockResolvedValue(items.map((i) => ({ id: i.productId })));
      prisma.orderTemplateItem.findMany.mockResolvedValue([
        { productId: "p-banned", qty: 2, suspendedAt: when, suspendedReason: "SELLING_RESTRICTED" },
      ]);
      await service.update("t1", { items } as never);
      return prisma.orderTemplate.update.mock.calls[0][0].data.items.create as any[];
    };

    it("keeps a suspension when that line's product and qty are unchanged (other lines / notes edits)", async () => {
      const created = await editWith([
        { productId: "p-banned", qty: 2 },
        { productId: "p-ok", qty: 9 },
      ]);
      expect(created.find((c) => c.productId === "p-banned").suspendedAt).toEqual(when);
      expect(created.find((c) => c.productId === "p-ok").suspendedAt).toBeUndefined();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it("clears it when THAT line's qty changes, with an audited lift", async () => {
      const created = await editWith([{ productId: "p-banned", qty: 5 }]);
      expect(created[0].suspendedAt).toBeUndefined();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "order-template.line-suspension-lifted",
          meta: { how: "EDITED", productId: "p-banned" },
        }),
      );
    });

    it("an explicit lift is audited with the actor; a line that is not suspended is a 400", async () => {
      prisma.orderTemplate.findUnique.mockResolvedValue(template());
      prisma.orderTemplateItem.findFirst.mockResolvedValue({
        id: "i1",
        productId: "p-banned",
        suspendedAt: when,
      });
      await service.liftItemSuspension("t1", "i1", { sub: "u7" } as never);
      expect(prisma.orderTemplateItem.update).toHaveBeenCalledWith({
        where: { id: "i1" },
        data: { suspendedAt: null, suspendedReason: null },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "u7", meta: { how: "LIFTED", productId: "p-banned" } }),
      );
      prisma.orderTemplateItem.findFirst.mockResolvedValue({ id: "i1", suspendedAt: null });
      await expect(
        service.liftItemSuspension("t1", "i1", { sub: "u7" } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
