/**
 * B975 (SA-606q): the buyer Reorder (OrderTemplatesService.generateOrder) reports the same per-line
 * `backorderPieces` as checkout, through the REAL OrdersService / OrderTemplatesService against a REAL
 * Postgres (WRITTEN, NOT RUN by the author: F2's DB lane runs it and adjusts any fixture field the
 * schema demands; the harness is oversell-policy.orders-service.db.spec.ts's, unchanged).
 *
 * Pins: the Reorder's locked write == the overshoot the TEMPLATE:<id> SALE movement recorded and the
 * response lines sum to it; a covered Reorder with the policy off reports 0 (present); a Reorder folded
 * into a pre-existing PENDING order attributes onto the merged order's lines (sum == overshoot).
 *
 * SAFETY: one throwaway `qa-oversell-os-<run>` tenant approved by `assertTestTenant`; `afterAll`
 * deletes exactly the rows this run created, in FK order. Run via `npm run local:test:db`.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { ConflictException, Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PolicyService } from "../policy/policy.service";
import { PolicyOversellReader } from "../orders/policy-oversell-reader";
import { OrdersService } from "../orders/orders.service";
import { OrderTemplatesService } from "./order-templates.service";
import { stockWriteOf } from "../orders/order-stock";
import { withBackorderPieces } from "../orders/backorder-response";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const KEY = "orders.buyerOversell";

describeDb(
  "B975 buyer Reorder backorderPieces through OrderTemplatesService, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient; // superuser fixture client, deliberately unscoped
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let policies: PolicyService;
    let orders: any;
    let templates: OrderTemplatesService;
    let readerRead: jest.Mock;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(
      `qa-oversell-os-${run}`,
      "order-templates.reorder-backorder.db.spec.ts",
    );
    const actor = { id: null, name: "qa-admin", impersonatedBy: null };
    let tenantId = "";
    let operatorUserId = "";
    let driverUserId = "";
    const buyerUserIds: string[] = [];
    const customerIds: string[] = []; // [c1, c2]
    let productId = "";

    const principal = (
      role: "CUSTOMER" | "OPERATOR" | "DRIVER",
      sub: string,
      username: string,
    ): JwtPayload =>
      ({
        sub,
        username,
        role,
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;
    const buyer = (n: 0 | 1) => principal("CUSTOMER", buyerUserIds[n], `buyer${n + 1}-${run}`);
    const operator = () => principal("OPERATOR", operatorUserId, `op-${run}`);
    const driver = () => principal("DRIVER", driverUserId, `drv-${run}`);

    const setPolicy = (
      value: string,
      scope: { scopeType: "TENANT" | "CUSTOMER"; scopeId?: string } = { scopeType: "TENANT" },
    ) =>
      tenantCtx.run(tenantId, () =>
        policies.set({ tenantId, key: KEY, reason: "qa", actor, value, ...scope }),
      );

    /** A single plain piece-line order create through the REAL OrdersService.create(). */
    const createOrder = (user: JwtPayload, qty: number, customerId?: string) =>
      tenantCtx.run(tenantId, () =>
        orders.create(
          { ...(customerId ? { customerId } : {}), items: [{ productId, qty }] },
          user,
          { skipAutoMerge: true },
        ),
      );

    /** The edit path: PATCH-style per-line qty change through the REAL OrdersService.updateOrderItems(). */
    const editQty = (orderId: string, qty: number, user: JwtPayload) =>
      tenantCtx.run(tenantId, () =>
        orders.updateOrderItems(orderId, { items: [{ productId, qty }] } as any, user),
      );

    const stockNow = async () =>
      Number((await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);
    const orderCount = () => raw.order.count({ where: { tenantId } });
    const saleMovements = () =>
      raw.stockMovement.findMany({
        where: { productId, type: "SALE" },
        orderBy: { createdAt: "asc" },
      });

    /** The write the service returned, and the response lines the buyer controller would put it on. */
    const figures = (order: any) => order.lineItems.map((l: any) => l.backorderPieces);
    const sum = (xs: Array<number | undefined>) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
    /** A standing order of `qty` for customer `n`; the Reorder is the buyer's (CUSTOMER) run. */
    const makeTemplate = async (n: 0 | 1, qty: number) =>
      raw.orderTemplate.create({
        data: {
          customerId: customerIds[n],
          name: `Weekly ${run}`,
          isActive: true,
          daysOfWeek: [1],
          tenantId,
          items: { create: [{ productId, qty, tenantId }] },
        },
      });
    const reorder = (templateId: string, allowOversell: boolean) =>
      tenantCtx.run(tenantId, () => templates.generateOrder(templateId, false, allowOversell));
    const overshootOf = async () => {
      const last = (await saleMovements()).at(-1);
      return last ? Math.max(0, -Number(last.stockAfter)) : 0;
    };

    async function wipeOrders() {
      const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
        (o) => o.id,
      );
      await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
      await raw.stockMovement.deleteMany({ where: { productId } });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.order.deleteMany({ where: { tenantId } });
      await raw.orderTemplateItem.deleteMany({ where: { tenantId } });
      await raw.orderTemplate.deleteMany({ where: { tenantId } });
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      policies = new PolicyService(prisma);
      const realReader = new PolicyOversellReader(policies);
      readerRead = jest.fn((a: { tenantId: string; customerId?: string | null }) =>
        realReader.read(a),
      );
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        gateway: {
          emitOrderCreated: jest.fn(),
          emitUrgentOrder: jest.fn(),
          emitOrderStatusChanged: jest.fn(),
          emitLowStock: jest.fn(),
        },
        notifications: {
          sendToCustomer: jest.fn().mockResolvedValue(undefined),
          sendToUser: jest.fn().mockResolvedValue(1),
        },
        messaging: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        systemConfig,
        entitlements: { hasFlag: async () => true },
        sellingRestrictions: {
          getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
          assertLinesSellable: async () => undefined,
        },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        tenantCtx,
        invoicesService: {
          findOpenOrderDraft: async () => null,
          revertLinkedInvoicesForOrderEdit: async () => undefined,
          resyncOrderInvoicesForEdit: async () => [],
          reconcileOrderDraftInvoice: async () => undefined,
        },
        creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        // The REAL PolicyService behind a counting wrapper of the REAL PolicyOversellReader.
        oversellReader: { read: readerRead },
      });

      templates = new OrderTemplatesService(
        prisma,
        tenantCtx,
        orders,
        {
          checkAuthorized: async () => ({ blocked: [] }),
          assertAuthorizedOrThrow: async () => undefined,
        } as any,
        { sendToCustomer: async () => 1, sendToUser: async () => 1 } as any,
        systemConfig,
        {
          assertLinesSellable: async () => undefined,
          checkLinesSellable: async () => ({ outcome: "ALLOW", reasons: [] }),
          getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        } as any,
        { read: readerRead } as any,
      );

      tenantId = (await raw.tenant.create({ data: { slug, name: `Oversell OS ${slug}` } })).id;
      operatorUserId = (
        await raw.user.create({
          data: {
            email: `op-${run}@example.test`,
            username: `op-${run}`,
            role: "OPERATOR",
            tenantId,
          },
        })
      ).id;
      driverUserId = (
        await raw.user.create({
          data: {
            email: `drv-${run}@example.test`,
            username: `drv-${run}`,
            role: "DRIVER",
            tenantId,
          },
        })
      ).id;
      for (const n of [1, 2]) {
        // eslint-disable-next-line no-await-in-loop
        const u = await raw.user.create({
          data: {
            email: `buyer${n}-${run}@example.test`,
            username: `buyer${n}-${run}`,
            role: "CUSTOMER",
            tenantId,
          },
        });
        buyerUserIds.push(u.id);
        // eslint-disable-next-line no-await-in-loop
        const c = await raw.customer.create({
          data: { userId: u.id, businessName: `Acme ${n}`, contactName: "Tester", tenantId },
        });
        customerIds.push(c.id);
      }
      // A plain piece product (no boxes, no unit ladder).
      productId = (
        await raw.product.create({
          data: {
            name: `Mango ${run}`,
            unit: "each",
            pricePerUnit: "1.00",
            currentStock: 5,
            tenantId,
          },
        })
      ).id;
    }, 120_000);

    beforeEach(async () => {
      await wipeOrders();
      await raw.policyValue.deleteMany({ where: { tenantId } });
      policies.invalidate(tenantId); // the 30 s cache must not carry a prior case's row
      await raw.product.update({ where: { id: productId }, data: { currentStock: 5 } });
      readerRead.mockClear();
    });

    afterAll(async () => {
      try {
        await wipeOrders();
        await raw.auditLog.deleteMany({ where: { tenantId } });
        await raw.policyValue.deleteMany({ where: { tenantId } });
        await raw.product.deleteMany({ where: { tenantId } });
        await raw.customer.deleteMany({ where: { tenantId } });
        await raw.user.deleteMany({ where: { tenantId } });
        await raw.tenant.deleteMany({ where: { id: tenantId } });
      } finally {
        await _resetLockPoolForTests();
        await prisma?.$disconnect();
        await raw?.$disconnect();
        await pool?.end();
      }
    }, 120_000);

    it("(R1) the Reorder's write == the TEMPLATE movement's overshoot, and the lines sum to it", async () => {
      await setPolicy("backorder");
      const tpl = await makeTemplate(0, 8); // stock 5 -> -3
      const order: any = await reorder(tpl.id, true);
      const write = stockWriteOf(order)!;
      expect(write.backorderByProduct.get(productId)).toBe(3);
      expect(await stockNow()).toBe(-3);
      expect(await overshootOf()).toBe(3);
      expect(sum(figures(withBackorderPieces(order, write)))).toBe(3);
    }, 120_000);

    it("(R2) a covered Reorder with the policy off reports 0 on its line (present)", async () => {
      const tpl = await makeTemplate(0, 3);
      const order: any = await reorder(tpl.id, false);
      expect(stockWriteOf(order)!.backorderByProduct.get(productId)).toBe(0);
      expect(figures(withBackorderPieces(order, stockWriteOf(order)))).toEqual([0]);
    }, 120_000);

    it("(R3) a Reorder folded into a pre-existing PENDING order: the merged lines sum to the overshoot", async () => {
      await setPolicy("backorder");
      await createOrder(buyer(0), 4); // stock 5 -> 1, a PENDING order the Reorder will fold into
      const tpl = await makeTemplate(0, 4); // 1 - 4 -> -3, overshoot 3
      const order: any = await reorder(tpl.id, true);
      const response: any = withBackorderPieces(order, stockWriteOf(order));
      expect(sum(figures(response))).toBe(3);
      expect(await overshootOf()).toBe(3);
    }, 120_000);
  },
);
