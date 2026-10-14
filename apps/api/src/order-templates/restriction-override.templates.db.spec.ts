/**
 * Row 510 (brief 3) - real-Postgres proof of a STANDING ORDER (order template) and its restricted lines, through the
 * real OrderTemplatesService, decrementStockForSale and the REAL SellingRestrictionsService (rules, labels, addresses
 * and the store state read from the database):
 *
 *   Generate (manual)   a staff member's run of a template holding a restricted line answers 409 RESTRICTION_WARNING and
 *                       writes nothing (no order, no stock movement, the template items untouched); the resubmit with the
 *                       ack creates the order with the restricted line STAMPED BY THE CLICKER and ONE audit row; the
 *                       template's own lines carry no stamp; SUPER_ADMIN gets the hard 409 SELLING_RESTRICTED; a PICKUP
 *                       customer's standing order is judged at the STORE's state.
 *   scheduled run       #2093: the restricted line is SKIPPED, the rest is ordered, the template line is SUSPENDED and
 *                       staff are told; no acknowledgement is asked, no stamp is written, and the next scheduled run starts
 *                       with no override.
 *   buyer Reorder       a CUSTOMER keeps the hard BUYER_PORTAL 409; no warning, no ack path.
 *
 * No `selling_restrictions.enabled` row exists. Collected only by jest.db.config.js. One throwaway `qa-r510-<run>` tenant
 * (assertTestTenant), purged in afterAll.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PrismaClient, UserRole } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { OrdersService } from "../orders/orders.service";
import { OrderTemplatesService } from "./order-templates.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { INVOICE_EDIT_STUBS } from "../orders/testing/invoice-edit-stubs";
import {
  purgeOverrideWorld,
  seedOverrideWorld,
  setStoreState,
  staffPayload,
  type OverrideWorld,
} from "../../test/restriction-override-fixture";

const RUN = randomUUID().slice(0, 8);
const REASON = "Licensed buyer, paperwork on file";
const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

describeDb(
  "row 510 (brief 3): a standing order warns on a manual run and skips the line when scheduled — real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let templates: OrderTemplatesService;
    let cronTemplates: OrderTemplatesService;
    let w: OverrideWorld;
    const notifications = {
      sendToCustomer: jest.fn().mockResolvedValue(undefined),
      sendToUser: jest.fn().mockResolvedValue(1),
    };

    const as = <T>(fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);
    const staff = (role: "OPERATOR" | "TENANT_ADMIN" | "SUPER_ADMIN" = "OPERATOR") =>
      staffPayload(w, role);
    const errOf = async (p: Promise<unknown>): Promise<any> => {
      try {
        await p;
      } catch (e) {
        return e;
      }
      throw new Error("expected a rejection");
    };
    const bodyOf = (e: any) => e.getResponse() as any;
    const ackFrom = (e: any) => ({
      warningHash: bodyOf(e).warningHash as string,
      restrictionOverrides: (bodyOf(e).lines as Array<{ lineKey: string }>).map((l) => ({
        lineKey: l.lineKey,
        reason: REASON,
      })),
    });
    const generate = (templateId: string, user = staff(), ack?: object) =>
      as(() => templates.generateOrderForUser(templateId, user, ack as never)) as Promise<any>;
    const ordersOf = (templateId: string) =>
      raw.order.findMany({
        where: { tenantId: w.tenantId, templateId },
        include: { lineItems: { orderBy: { position: "asc" } } },
      });
    const audits = (orderId: string) =>
      raw.auditLog.findMany({
        where: {
          tenantId: w.tenantId,
          action: "selling_restriction.overridden",
          meta: { path: ["documentId"], equals: orderId },
        },
      });

    async function makeTemplate(
      productIds: string[],
      over: { customerId?: string; pickup?: boolean } = {},
    ) {
      const customerId = over.customerId ?? w.caCustomerId;
      if (over.pickup)
        await raw.customer.update({ where: { id: customerId }, data: { fulfillPath: "PICKUP" } });
      return raw.orderTemplate.create({
        data: {
          tenantId: w.tenantId,
          customerId,
          name: `T ${randomUUID().slice(0, 6)}`,
          daysOfWeek: ALL_WEEKDAYS,
          createdByRole: UserRole.OPERATOR,
          itemsEditedByRole: UserRole.OPERATOR,
          items: {
            create: productIds.map((productId) => ({ tenantId: w.tenantId, productId, qty: 2 })),
          },
        },
        include: { items: true },
      });
    }

    function build(prismaForService: PrismaService, restrictions: SellingRestrictionsService) {
      const ordersService = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        tenantCtx,
        gateway: {
          emitOrderCreated: jest.fn(),
          emitUrgentOrder: jest.fn(),
          emitOrderStatusChanged: jest.fn(),
          emitLowStock: jest.fn(),
        },
        notifications,
        messaging: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        entitlements: { hasFlag: async () => true },
        systemConfig: { get: async () => "0" },
        sellingRestrictions: restrictions,
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        invoicesService: {
          findOpenOrderDraft: async () => null,
          revertLinkedInvoicesForOrderEdit: async () => undefined,
          resyncOrderInvoicesForEdit: async () => [],
          ...INVOICE_EDIT_STUBS,
          reconcileOrderDraftInvoice: async () => undefined,
        },
        creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        oversellReader: { read: async () => "off" },
      }) as OrdersService;
      return new OrderTemplatesService(
        prismaForService,
        tenantCtx,
        ordersService,
        { checkAuthorized: async () => ({ blocked: [] }) } as any,
        notifications as any,
        { get: jest.fn().mockResolvedValue("0") } as any,
        restrictions,
        { read: async () => "off" } as any,
      );
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const restrictions = new SellingRestrictionsService(prisma, new ProductLabelsService(prisma));
      w = await seedOverrideWorld(raw, RUN, "restriction-override.templates.db.spec.ts");
      await setStoreState(raw, w.tenantId, null);
      templates = build(prisma, restrictions);
      // the cron lists ACTIVE tenants from the whole database; narrow that one read to ours
      const scoped = new Proxy(prisma, {
        get(target, key) {
          if (key === "tenant") return { findMany: async () => [{ id: w.tenantId }] };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      cronTemplates = build(scoped as unknown as PrismaService, restrictions);
    }, 120_000);

    afterAll(async () => {
      if (w?.tenantId) await purgeOverrideWorld(pool, w.tenantId);
      await _resetLockPoolForTests();
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    beforeEach(async () => {
      notifications.sendToUser.mockClear();
      notifications.sendToCustomer.mockClear();
      // each case starts with no orders or templates: the pending-order merge and the cron both look at the whole tenant
      await raw.stockMovement.deleteMany({ where: { product: { tenantId: w.tenantId } } });
      await raw.orderItem.deleteMany({ where: { tenantId: w.tenantId } });
      await raw.order.deleteMany({ where: { tenantId: w.tenantId } });
      await raw.orderTemplateItem.deleteMany({ where: { tenantId: w.tenantId } });
      await raw.orderTemplate.deleteMany({ where: { tenantId: w.tenantId } });
    });

    describe("Generate (manual, staff)", () => {
      it("warns the clicker and writes NOTHING: no order, no stock movement, the template lines untouched", async () => {
        const t = await makeTemplate([w.banned, w.clean]);
        const stockBefore = Number(
          (await raw.product.findUniqueOrThrow({ where: { id: w.banned } })).currentStock,
        );
        const e = await errOf(generate(t.id));
        expect(e.getStatus()).toBe(409);
        expect(bodyOf(e)).toMatchObject({
          code: "RESTRICTION_WARNING",
          warningHash: expect.stringMatching(/^rw1:/),
          lines: [{ lineKey: "n:0", productId: w.banned }],
        });
        expect(await ordersOf(t.id)).toHaveLength(0);
        expect(
          Number((await raw.product.findUniqueOrThrow({ where: { id: w.banned } })).currentStock),
        ).toBe(stockBefore);
        const items = await raw.orderTemplateItem.findMany({ where: { templateId: t.id } });
        expect(items.every((i) => i.suspendedAt === null)).toBe(true);
        expect(notifications.sendToCustomer).not.toHaveBeenCalled();
      });

      it("the resubmit with the ack orders ALL the lines, stamps the restricted one BY THE CLICKER and writes ONE audit row", async () => {
        const t = await makeTemplate([w.banned, w.clean]);
        const e = await errOf(generate(t.id, staff("TENANT_ADMIN")));
        const order = await generate(t.id, staff("TENANT_ADMIN"), ackFrom(e));
        const [stored] = await ordersOf(t.id);
        expect(stored.id).toBe(order.id);
        expect(stored.lineItems).toHaveLength(2);
        const banned = stored.lineItems.find((l) => l.productId === w.banned)!;
        expect(banned).toMatchObject({
          restrictionOverrideReason: REASON,
          restrictionOverrideBy: w.adminId,
          restrictionOverrideRuleIds: [`${w.ruleId}:CA`],
        });
        expect(banned.restrictionOverrideAt).toBeInstanceOf(Date);
        expect(stored.lineItems.filter((l) => l.restrictionOverrideAt !== null)).toHaveLength(1);
        expect(await audits(stored.id)).toHaveLength(1);
        // nothing is carried onto the template itself
        const items = await raw.orderTemplateItem.findMany({ where: { templateId: t.id } });
        expect(items.every((i) => i.suspendedAt === null)).toBe(true);
      });

      it("a clean template runs untouched: no warning, no stamp, no audit row", async () => {
        const t = await makeTemplate([w.clean]);
        const order = await generate(t.id);
        const [stored] = await ordersOf(t.id);
        expect(stored.id).toBe(order.id);
        expect(stored.lineItems.every((l) => l.restrictionOverrideAt === null)).toBe(true);
        expect(await audits(stored.id)).toHaveLength(0);
      });

      it("SUPER_ADMIN may not override: the hard 409 SELLING_RESTRICTED", async () => {
        const t = await makeTemplate([w.banned]);
        const e = await errOf(generate(t.id, staff("SUPER_ADMIN")));
        expect(bodyOf(e).code).toBe("SELLING_RESTRICTED");
        expect(await ordersOf(t.id)).toHaveLength(0);
      });

      it("a PICKUP customer's standing order is judged at the STORE: a TX customer at a CA store warns, a CA customer at a TX store does not", async () => {
        await setStoreState(raw, w.tenantId, "CA");
        try {
          const tx = await makeTemplate([w.banned], { customerId: w.txCustomerId, pickup: true });
          const e = await errOf(generate(tx.id));
          expect(bodyOf(e).code).toBe("RESTRICTION_WARNING");
          expect(bodyOf(e).lines[0].rules[0].reasonText).toBe(
            "This product is banned in CA by law.",
          );
          const order = await generate(tx.id, staff(), ackFrom(e));
          expect((await audits(order.id))[0].meta).toMatchObject({ basis: "STORE" });
        } finally {
          await setStoreState(raw, w.tenantId, "TX");
        }
        try {
          const ca = await makeTemplate([w.banned], { customerId: w.caCustomerId, pickup: true });
          const order = await generate(ca.id);
          const [stored] = await ordersOf(ca.id);
          expect(stored.id).toBe(order.id);
          expect(stored.lineItems[0].restrictionOverrideAt).toBeNull();
        } finally {
          await setStoreState(raw, w.tenantId, null);
          await raw.customer.updateMany({
            where: { tenantId: w.tenantId },
            data: { fulfillPath: "ROUTE" },
          });
        }
      });
    });

    describe("buyer Reorder", () => {
      it("a CUSTOMER keeps the hard portal 409 (redacted body); no warning, no order", async () => {
        const t = await makeTemplate([w.banned]);
        const customer = await raw.customer.findUniqueOrThrow({ where: { id: w.caCustomerId } });
        const buyer = {
          sub: customer.userId,
          username: "buyer-r510",
          role: "CUSTOMER",
          status: "ACTIVE",
          forcePasswordChange: false,
          tenantId: w.tenantId,
          tenantSlug: w.slug,
        } as never;
        const e = await errOf(generate(t.id, buyer));
        expect(bodyOf(e).code).toBe("SELLING_RESTRICTED");
        expect(JSON.stringify(bodyOf(e))).not.toContain(w.ruleId);
        expect(await ordersOf(t.id)).toHaveLength(0);
      });
    });

    describe("scheduled run (#2093)", () => {
      it("skips the restricted line, orders the rest, SUSPENDS the template line, tells staff once; no ack asked, no stamp written", async () => {
        const t = await makeTemplate([w.banned, w.clean]);
        await cronTemplates.generateDailyOrders();
        const [stored] = await ordersOf(t.id);
        expect(stored.lineItems.map((l) => l.productId)).toEqual([w.clean]);
        expect(stored.lineItems.every((l) => l.restrictionOverrideAt === null)).toBe(true);
        expect(await audits(stored.id)).toHaveLength(0);
        const items = await raw.orderTemplateItem.findMany({ where: { templateId: t.id } });
        const bannedItem = items.find((i) => i.productId === w.banned)!;
        expect(bannedItem.suspendedAt).toBeInstanceOf(Date);
        expect(bannedItem.suspendedReason).toBe("SELLING_RESTRICTED");
        expect(items.find((i) => i.productId === w.clean)!.suspendedAt).toBeNull();
        expect(notifications.sendToUser).toHaveBeenCalled();
        expect(
          await raw.orderItem.count({
            where: {
              tenantId: w.tenantId,
              restrictionOverrideAt: { not: null },
              order: { templateId: t.id },
            },
          }),
        ).toBe(0);
      });
    });
  },
);
