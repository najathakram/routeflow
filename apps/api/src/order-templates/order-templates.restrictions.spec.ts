jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

/**
 * F-05 (#2093, owner rulings 2026-09-25, SA-205/SA-210) — a standing order SELLS its lines.
 *  - a MANUAL run (Generate now / Reorder) is refused with the 409 (the operator decides);
 *  - the UNATTENDED run skips the banned line(s), orders the rest, notifies once and suspends THAT template
 *    line (an AuditLog row); an all-banned or all-suspended template orders nothing, still with a notice;
 *  - the run's channel follows the template's snapshotted creator through the live predicate, and unknown
 *    provenance (NULL) is the STRICTER buyer channel, never staff, EXCEPT that a legacy template (a NULL role
 *    beside known staff) is staff-built, so a portal-only limit never suspends its lines (a legal ban still does);
 *  - an edit keeps a line's suspension unless THAT line's product or qty changed (audited lift); an explicit
 *    lift is its own audited action.
 * The choke point itself is proven in `selling-restrictions.service.spec.ts`.
 */
import { regulatedGateOpenProvider } from "./testing/regulated-gate-open-provider";
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
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
import * as orderStock from "../orders/order-stock";
import { createMockPrisma } from "../testing/prisma-mock";

describe("OrderTemplatesService — selling restrictions (F-05)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const restrictions = { assertLinesSellable: jest.fn(), checkLinesSellable: jest.fn() };
  const notifications = { sendToCustomer: jest.fn(), sendToUser: jest.fn() };
  const audit = { log: jest.fn() };
  const authGuard = { checkAuthorized: jest.fn() };
  const entitlements = { hasFlagStrict: jest.fn() };
  const ordersService = {
    entitlements,
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
  /** The customer has a typed unit price, so the units_prices_v2 flag is consulted (and can fail). */
  const typedPrice = (rows: object[]) => {
    (prisma.forTenant() as any).customerUnitPrice = { findMany: jest.fn().mockResolvedValue(rows) };
  };
  /** The unattended 06:00 run, through the real cron entry (its caller sends the ban notice). */
  const run = async (t: object) => {
    prisma.tenant.findMany.mockResolvedValue([{ id: "tn-1" }]);
    prisma.orderTemplate.findMany.mockResolvedValue([t]);
    prisma.orderTemplate.count.mockResolvedValue(0);
    prisma.order.findFirst.mockResolvedValue(null);
    await service.generateDailyOrders();
    return prisma.order.create.mock.calls.length > 0 ? { ordered: true } : null;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue("test-tenant");
    restrictions.assertLinesSellable.mockResolvedValue(undefined);
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
        regulatedGateOpenProvider,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_i, fn) => fn()) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: ordersService },
        { provide: AuthorizationGuardService, useValue: authGuard },
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
    it.each([
      ["PICKUP", "PICKUP"],
      ["SHIP", "DELIVERY"],
      ["ROUTE", "DELIVERY"],
    ])(
      "L8: a standing order whose resolved path is %s is judged as %s (pickup: the store's state)",
      async (path, kind) => {
        prisma.customer.findFirst.mockResolvedValue({ fulfillPath: path });
        restrictions.assertLinesSellable.mockRejectedValue(
          new ConflictException({ code: "SELLING_RESTRICTED", blockedLines: [] }),
        );
        await expect(service.generateOrder("t1")).rejects.toBeDefined();
        expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
          expect.objectContaining({ fulfilmentKind: kind }),
        );
      },
    );

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
        // row 510: each line carries its stable key; no actor on an internal call (so it can never override)
        lines: [
          { productId: "p-banned", lineKey: "n:0" },
          { productId: "p-ok", lineKey: "n:1" },
        ],
        path: "DELIVERY",
        principal: undefined,
        ack: undefined,
        document: "ORDER",
        channel: "STAFF",
        fulfilmentKind: "DELIVERY",
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
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "order-template.line-suspended",
          entityId: "t1",
          meta: expect.objectContaining({ ruleIds: ["rule-1"], reason: "SELLING_RESTRICTED" }),
        }),
      });
      expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
      expect(notifications.sendToCustomer.mock.calls[0][2]).toContain("Banned Cola");
      expect(notifications.sendToUser).toHaveBeenCalledTimes(1);
    });

    // SA-812a G-1: the cron re-attempts a template whose customer prices could not be loaded. The retry re-enters
    // createOrderFromTemplate, whose pre-pricing steps suspend + audit the banned lines and notify. It must not repeat them.
    it("G-1: a ban + a customer-prices 503, then the retry: ONE suspension audit row and ONE buyer notice (ordered)", async () => {
      restrictions.checkLinesSellable.mockResolvedValue(block);
      jest.spyOn(service as any, "pause").mockResolvedValue(undefined);
      typedPrice([{ productId: "p-ok", unitRef: "pack", price: "3" }]);
      entitlements.hasFlagStrict
        .mockRejectedValueOnce(new Error("entitlements down"))
        .mockResolvedValue(false);
      await run(template());
      expect(entitlements.hasFlagStrict).toHaveBeenCalledTimes(2); // the attempt and exactly one retry
      expect(prisma.order.create).toHaveBeenCalledTimes(1);
      expect(prisma.orderTemplateItem.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
      expect(notifications.sendToCustomer.mock.calls[0][2]).toContain("went ahead");
      expect(notifications.sendToCustomer.mock.calls[0][2]).not.toContain("was not sent");
    });

    it("G-1: a ban + a customer-prices 503 twice: still ONE audit row and ONE buyer notice (held), operators told", async () => {
      restrictions.checkLinesSellable.mockResolvedValue(block);
      jest.spyOn(service as any, "pause").mockResolvedValue(undefined);
      typedPrice([{ productId: "p-ok", unitRef: "pack", price: "3" }]);
      entitlements.hasFlagStrict.mockRejectedValue(new Error("entitlements down"));
      await run(template());
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
      expect(notifications.sendToCustomer.mock.calls[0][2]).toContain("was not sent this time");
      // ban notice (1) + the "held, use Generate now" notice (1), to the one operator
      const bodies = notifications.sendToUser.mock.calls.map((c) => c[1].body as string);
      expect(bodies.some((b) => b.includes("Generate now"))).toBe(true);
    });

    it("G-1: a regulated skip + a customer-prices 503, then the retry: the skip is announced ONCE", async () => {
      jest.spyOn(service as any, "pause").mockResolvedValue(undefined);
      authGuard.checkAuthorized.mockResolvedValue({
        blocked: [{ trackedCategoryId: "cat-r", categoryName: "Tobacco" }],
      });
      prisma.product.findMany.mockResolvedValue([
        { id: "p-banned", pricePerUnit: 10, trackedCategoryId: "cat-r" },
        { id: "p-ok", pricePerUnit: 5, trackedCategoryId: null },
      ]);
      typedPrice([{ productId: "p-ok", unitRef: "pack", price: "3" }]);
      entitlements.hasFlagStrict
        .mockRejectedValueOnce(new Error("entitlements down"))
        .mockResolvedValue(false);
      await run(template());
      expect(prisma.order.create).toHaveBeenCalledTimes(1);
      const regulated = notifications.sendToCustomer.mock.calls.filter((c) =>
        /Regulated items skipped/.test(c[1]),
      );
      expect(regulated).toHaveLength(1);
    });

    it("an all-banned template orders nothing, says 'not sent' (never 'went ahead'), and deactivates it", async () => {
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
      expect(prisma.orderTemplate.update).toHaveBeenCalledWith({
        where: { id: "t1" },
        data: { isActive: false },
      });
      expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
      expect(notifications.sendToCustomer.mock.calls[0][2]).toContain("was not sent");
      expect(notifications.sendToCustomer.mock.calls[0][2]).not.toContain("went ahead");
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

    it("an all-suspended template is deactivated and notified ONCE, never an empty order", async () => {
      const t = template({ items: [line("p-banned", { suspendedAt: new Date() })] });
      expect(await run(t)).toBeNull();
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(prisma.orderTemplate.update).toHaveBeenCalledWith({
        where: { id: "t1" },
        data: { isActive: false },
      });
      expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
      expect(notifications.sendToUser).toHaveBeenCalledTimes(1);
    });

    it.each([
      // [createdByRole, itemsEditedByRole, channel]: STAFF only when BOTH are known staff (SA-247)
      ["CUSTOMER", "CUSTOMER", "BUYER_PORTAL"],
      ["OPERATOR", "OPERATOR", "STAFF"],
      ["TENANT_ADMIN", "OPERATOR", "STAFF"],
      ["OPERATOR", "CUSTOMER", "BUYER_PORTAL"], // a buyer edited an operator's template
      ["CUSTOMER", "OPERATOR", "BUYER_PORTAL"],
      ["OPERATOR", null, "BUYER_PORTAL"], // unknown last editor is the stricter channel, never staff
      [null, "OPERATOR", "BUYER_PORTAL"],
      [null, null, "BUYER_PORTAL"],
    ])(
      "channel: created by %s, items last edited by %s is evaluated as %s",
      async (c, e, channel) => {
        await run(template({ createdByRole: c, itemsEditedByRole: e }));
        expect(restrictions.checkLinesSellable).toHaveBeenCalledWith(
          expect.objectContaining({ channel }),
        );
      },
    );

    it.each([
      // [createdByRole, itemsEditedByRole, a portal-only limit is skipped]: legacy provenance (a NULL role beside
      // known staff) is a staff-built template, so a portal limit never suspends its lines; a legal ban still binds.
      ["OPERATOR", null, true],
      [null, "OPERATOR", true],
      [null, null, true],
      ["OPERATOR", "OPERATOR", false], // known staff: judged as STAFF, portal-only rules never bind it anyway
      ["CUSTOMER", null, false], // a buyer authored it: the full portal rules
      ["OPERATOR", "CUSTOMER", false],
      ["CUSTOMER", "CUSTOMER", false],
    ])(
      "legacy provenance: created by %s, edited by %s skips portal-only limits = %s",
      async (c, e, skips) => {
        await run(template({ createdByRole: c, itemsEditedByRole: e }));
        const arg = restrictions.checkLinesSellable.mock.calls[0][0];
        expect(Boolean(arg.skipPortalOnlyRules)).toBe(skips);
      },
    );

    it("the ban-note reads 'went ahead' only when something was ordered, and once", async () => {
      restrictions.checkLinesSellable.mockResolvedValue(block);
      await run(template());
      expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
      expect(notifications.sendToCustomer.mock.calls[0][2]).toContain("went ahead");
    });
  });

  describe("license-gated lines are NOT a ban (Opus #2125)", () => {
    const licenseBlocked = { blocked: [{ trackedCategoryId: "cat-tob", categoryName: "Tobacco" }] };
    const withCategory = () =>
      prisma.product.findMany.mockResolvedValue([
        { id: "p-banned", pricePerUnit: 10, trackedCategoryId: "cat-tob" },
        { id: "p-ok", pricePerUnit: 5, trackedCategoryId: "cat-tob" },
      ]);

    it("a template whose EVERY line is license-gated returns null with NO ban notice, on the cron and a manual run", async () => {
      withCategory();
      authGuard.checkAuthorized.mockResolvedValue(licenseBlocked);
      expect(await run(template())).toBeNull(); // cron
      await expect(service.generateOrder("t1")).rejects.toBeDefined(); // manual: "needs a license" 400
      const banTexts = [
        ...notifications.sendToCustomer.mock.calls.map((c) => String(c[2])),
        ...notifications.sendToUser.mock.calls.map((c) => String(c[1].body)),
      ].filter((t) => /nothing on it can be sold|is deactivated|suspended/.test(t));
      expect(banTexts).toEqual([]);
      expect(prisma.orderTemplate.update).not.toHaveBeenCalled();
    });

    it("banned + license-gated: 'not sent this time', never a false 'deactivated', and the template stays active", async () => {
      withCategory();
      // p-banned is banned; the license guard then blocks the rest
      restrictions.checkLinesSellable.mockResolvedValue(block);
      authGuard.checkAuthorized.mockResolvedValue(licenseBlocked);
      expect(await run(template())).toBeNull();
      const all = [
        ...notifications.sendToCustomer.mock.calls.map((c) => String(c[2])),
        ...notifications.sendToUser.mock.calls.map((c) => String(c[1].body)),
      ].join(" | ");
      expect(all).toContain("not sent this time");
      expect(all).not.toContain("deactivated");
      expect(prisma.orderTemplate.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { isActive: false } }),
      );
    });

    it("a throw AFTER the suspension committed still sends the ban notice (it is not lost for good)", async () => {
      restrictions.checkLinesSellable.mockResolvedValue(block);
      prisma.order.create.mockRejectedValue(new Error("db hiccup"));
      await run(template()); // the cron logs the failure and moves on
      expect(prisma.orderTemplateItem.updateMany).toHaveBeenCalledTimes(1);
      expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
      // nothing was placed (the write threw), so it must not claim the order went ahead
      const text = String(notifications.sendToCustomer.mock.calls[0][2]);
      expect(text).toContain("not sent this time");
      expect(text).not.toContain("went ahead");
    });

    it("an in-tx write AFTER order.create rejects (stock decrement): the tx rolls back, nothing was placed, so 'not sent this time' (moving `placed` inside the tx would go red)", async () => {
      restrictions.checkLinesSellable.mockResolvedValue(block);
      const spy = jest
        .spyOn(orderStock, "decrementStockForSale")
        .mockRejectedValue(new Error("stock write failed"));
      await run(template()); // the cron logs the failure and moves on
      expect(prisma.order.create).toHaveBeenCalledTimes(1); // the create call ran INSIDE the tx that then failed
      const text = String(notifications.sendToCustomer.mock.calls[0][2]);
      expect(text).toContain("not sent this time");
      expect(text).not.toContain("went ahead");
      spy.mockRestore();
    });

    it("the tx callback RUNS to its end and then the COMMIT rejects: nothing was placed, so 'not sent this time' (a `placed` set as the callback's last statement would go red)", async () => {
      restrictions.checkLinesSellable.mockResolvedValue(block);
      const realTx = prisma.tenantTransaction.getMockImplementation() as (fn: any) => Promise<any>;
      prisma.tenantTransaction.mockImplementation(async (fn: any) => {
        const out = await realTx(fn);
        if (out?.orderNumber) throw new Error("commit failed"); // the order tx only
        return out;
      });
      await run(template()); // the cron logs the failure and moves on
      expect(prisma.order.create).toHaveBeenCalledTimes(1);
      const text = String(notifications.sendToCustomer.mock.calls[0][2]);
      expect(text).toContain("not sent this time");
      expect(text).not.toContain("went ahead");
    });

    it("the order tx COMMITS and the post-commit merge THROWS: the notice says 'went ahead' (a duplicate re-order is not invited)", async () => {
      restrictions.checkLinesSellable.mockResolvedValue(block);
      ordersService.mergeAllPendingForCustomer.mockRejectedValue(new Error("merge blew up"));
      await run(template()); // the cron logs the failure and moves on
      expect(prisma.order.create).toHaveBeenCalledTimes(1);
      const text = String(notifications.sendToCustomer.mock.calls[0][2]);
      expect(text).toContain("went ahead");
      expect(text).not.toContain("not sent this time");
    });
  });

  describe("manual run and suspended lines", () => {
    it("a manual run does not order a suspended line, and refuses when every line is suspended", async () => {
      prisma.orderTemplate.findUnique.mockResolvedValue(
        template({ items: [line("p-banned", { suspendedAt: new Date() }), line("p-ok")] }),
      );
      await service.generateOrder("t1");
      expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({ lines: [{ productId: "p-ok", lineKey: "n:0" }] }),
      );
      expect(prisma.order.create.mock.calls[0][0].data.lineItems.create).toHaveLength(1);
      prisma.orderTemplate.findUnique.mockResolvedValue(
        template({ items: [line("p-banned", { suspendedAt: new Date() })] }),
      );
      await expect(service.generateOrder("t1")).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("buyer reorder: portal limits (lines hidden from this buyer are left out, with `skipped`)", () => {
    const hidden = {
      outcome: "BLOCK",
      reasons: [{ productId: "p-banned", productName: "Banned Cola", ruleId: "rule-1" }],
    };

    it("(h) drops the restricted line, orders the rest, and returns it in `skipped`", async () => {
      restrictions.checkLinesSellable.mockResolvedValue(hidden);
      const outcome = { skipped: [] as Array<{ productId: string; name: string }> };

      await service.generateOrder("t1", false, false, outcome);

      expect(restrictions.checkLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "BUYER_PORTAL" }),
      );
      // the 409 authority is still asked, but only about the lines left in
      expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({
          lines: [{ productId: "p-ok", lineKey: "n:0" }],
          channel: "BUYER_PORTAL",
        }),
      );
      expect(
        prisma.order.create.mock.calls[0][0].data.lineItems.create.map((l: any) => l.productId),
      ).toEqual(["p-ok"]);
      expect(outcome.skipped).toEqual([{ productId: "p-banned", name: "Banned Cola" }]);
    });

    it("an INDETERMINATE verdict (legal ban, no state on file) drops the line too", async () => {
      restrictions.checkLinesSellable.mockResolvedValue({ ...hidden, outcome: "INDETERMINATE" });
      const outcome = { skipped: [] as Array<{ productId: string; name: string }> };
      await service.generateOrder("t1", false, false, outcome);
      expect(outcome.skipped.map((l) => l.productId)).toEqual(["p-banned"]);
    });

    it("when every line is restricted it answers with the calm sentence and places nothing", async () => {
      prisma.orderTemplate.findUnique.mockResolvedValue(template({ items: [line("p-banned")] }));
      restrictions.checkLinesSellable.mockResolvedValue(hidden);

      await expect(service.generateOrder("t1", false, false, { skipped: [] })).rejects.toThrow(
        "None of these items are available to you right now.",
      );
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("nothing restricted: skipped stays empty and the order is whole", async () => {
      const outcome = { skipped: [] as Array<{ productId: string; name: string }> };
      await service.generateOrder("t1", false, false, outcome);
      expect(outcome.skipped).toEqual([]);
      expect(prisma.order.create.mock.calls[0][0].data.lineItems.create).toHaveLength(2);
    });

    it("a customer's own /generate (no `skipped` out-param) is NOT trimmed: it keeps the 409 and the lines named", async () => {
      restrictions.assertLinesSellable.mockRejectedValue(
        new ConflictException({ code: "SELLING_RESTRICTED", message: "banned", blockedLines: [] }),
      );
      restrictions.checkLinesSellable.mockResolvedValue(hidden);
      await expect(service.generateOrder("t1", false, false)).rejects.toMatchObject({
        response: { code: "SELLING_RESTRICTED" },
      });
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("a STAFF manual run is NOT trimmed: the operator still gets the 409", async () => {
      restrictions.assertLinesSellable.mockRejectedValue(
        new ConflictException({ code: "SELLING_RESTRICTED", message: "banned", blockedLines: [] }),
      );
      restrictions.checkLinesSellable.mockResolvedValue(hidden);
      await expect(service.generateOrder("t1", true)).rejects.toMatchObject({
        response: { code: "SELLING_RESTRICTED" },
      });
      expect(restrictions.checkLinesSellable).not.toHaveBeenCalled();
      expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({
          lines: [
            { productId: "p-banned", lineKey: "n:0" },
            { productId: "p-ok", lineKey: "n:1" },
          ],
        }),
      );
    });
  });

  describe("SA ruling (#3418): every generated line carries its explicit author marker", () => {
    const markers = () =>
      prisma.order.create.mock.calls[0][0].data.lineItems.create.map((l: any) => l.authorChannel);

    it("a STAFF manual run writes STAFF on each line", async () => {
      await service.generateOrder("t1", true);
      expect(markers()).toEqual(["STAFF", "STAFF"]);
    });

    it("a buyer's manual run (reorder) writes BUYER on each line", async () => {
      await service.generateOrder("t1", false);
      expect(markers()).toEqual(["BUYER", "BUYER"]);
    });

    it("the unattended run writes the least privileged author: STAFF for a staff-only template", async () => {
      await run(template({ createdByRole: "OPERATOR", itemsEditedByRole: "OPERATOR" }));
      expect(markers()).toEqual(["STAFF", "STAFF"]);
    });

    it("the unattended run writes BUYER once a buyer edited the template (or the author is unknown)", async () => {
      await run(template({ createdByRole: "OPERATOR", itemsEditedByRole: "CUSTOMER" }));
      expect(markers()).toEqual(["BUYER", "BUYER"]);
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
        itemsEditedByRole: "OPERATOR",
      });
      expect(prisma.orderTemplate.create.mock.calls[1][0].data).toMatchObject({
        createdByRole: null,
        createdByUserId: null,
        itemsEditedByRole: null,
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
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("clears it when THAT line's qty changes, with an audited lift", async () => {
      const created = await editWith([{ productId: "p-banned", qty: 5 }]);
      expect(created[0].suspendedAt).toBeUndefined();
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "order-template.line-suspension-lifted",
          meta: { how: "EDITED", productId: "p-banned" },
        }),
      });
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
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "u7",
          meta: { how: "LIFTED", productId: "p-banned" },
        }),
      });
      prisma.orderTemplateItem.findFirst.mockResolvedValue({ id: "i1", suspendedAt: null });
      await expect(
        service.liftItemSuspension("t1", "i1", { sub: "u7" } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
