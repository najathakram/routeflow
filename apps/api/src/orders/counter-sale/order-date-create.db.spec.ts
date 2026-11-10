/**
 * W-1188 (SA ruling 2026-11-09), real Postgres: what create() writes for a dated counter sale.
 *  - R9: the stored `orderDate` is midnight UTC of the chosen day; `createdAt` stays the entry instant.
 *  - R17: ONE `order.dated` audit row (BACK, days -3, surface counter) for a dated sale, none for an undated one.
 *  - R15: a month with a LOCKED filing for a category in the cart: 409 ORDER_DATE_PERIOD_LOCKED, ZERO orders, stock
 *    unchanged (master: the order was written, stock decremented, and the invoice step then threw LEDGER_PERIOD_LOCKED).
 *  - R16 (guard): the same locked month with no regulated line is created.
 * Same `Object.create` harness as counter-sale-replay.db.spec.ts; test tenant only; collected only by jest.db.config.js.
 */
jest.mock("../../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { addDays, tenantDayOf } from "@routeflow/pricing";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { EncryptionService } from "../../common/encryption.service";
import { SystemConfigService } from "../../system-config/system-config.service";
import { OrdersService } from "../orders.service";
import type { JwtPayload } from "../../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

describeDb("W-1188 a dated counter sale, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-odate-${run}`, "order-date-create.db.spec.ts");
  let tenantId = "";
  let operatorId = "";
  let customerId = "";
  let customerUserId = "";
  let categoryId = "";
  const productIds: string[] = [];
  const today = tenantDayOf(new Date(), null); // the test tenant has no zone: UTC
  const threeBack = addDays(today, -3);
  const lockedMonth = threeBack.slice(0, 7);

  const staff = (): JwtPayload =>
    ({
      sub: operatorId,
      username: "operator",
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  async function product(regulated: boolean): Promise<string> {
    const p = await raw.product.create({
      data: {
        name: `p ${randomUUID().slice(0, 6)} ${run}`,
        unit: "each",
        pricePerUnit: "2.50",
        currentStock: 100,
        tenantId,
        ...(regulated ? { trackedCategoryId: categoryId } : {}),
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  const ring = (productId: string, orderDate?: string) =>
    tenantCtx.run(tenantId, () =>
      orders.create(
        { customerId, items: [{ productId, qty: 2 }], ...(orderDate ? { orderDate } : {}) },
        staff(),
        { skipAutoMerge: true, counterSale: true },
      ),
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as any),
    );
    orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      gateway: { emitOrderCreated: jest.fn(), emitUrgentOrder: jest.fn() },
      systemConfig,
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: { assertLinesSellable: async () => undefined },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      ledger: {},
      tenantCtx,
      logger: new Logger(OrdersService.name),
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `Order date ${slug}` } })).id;
    operatorId = (
      await raw.user.create({
        data: {
          email: `op-${run}@example.test`,
          username: `op-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      })
    ).id;
    customerUserId = (
      await raw.user.create({
        data: { email: `c-${run}@example.test`, username: `c-${run}`, role: "CUSTOMER", tenantId },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId: customerUserId, businessName: "odate co", contactName: "Tester", tenantId },
      })
    ).id;
    categoryId = (await raw.trackedCategory.create({ data: { tenantId, name: "Tobacco" } })).id;
  }, 120_000);

  afterAll(async () => {
    const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
      (o) => o.id,
    );
    await raw.auditLog.deleteMany({ where: { tenantId } });
    await raw.regulatedFiling.deleteMany({ where: { tenantId } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await raw.order.deleteMany({ where: { id: { in: ids } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.trackedCategory.deleteMany({ where: { tenantId } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.systemConfig.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({ where: { id: { in: [operatorId, customerUserId] } } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("R9 + R17: the day is stored, the entry time kept, and ONE order.dated row is written (none when undated)", async () => {
    const productId = await product(false);
    const dated = await ring(productId, threeBack);
    const stored = await raw.order.findUniqueOrThrow({ where: { id: dated.id } });
    expect(stored.orderDate?.toISOString()).toBe(`${threeBack}T00:00:00.000Z`);
    expect(Date.now() - stored.createdAt.getTime()).toBeLessThan(60_000); // the real entry instant
    const rows = await raw.auditLog.findMany({ where: { tenantId, action: "order.dated" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe(dated.id);
    expect(rows[0].userId).toBe(operatorId);
    expect(rows[0].meta).toMatchObject({
      direction: "BACK",
      days: -3,
      surface: "counter",
      orderDay: threeBack,
      enteredDay: today,
    });

    const undated = await ring(productId);
    expect((await raw.order.findUniqueOrThrow({ where: { id: undated.id } })).orderDate).toBeNull();
    expect(await raw.auditLog.count({ where: { tenantId, action: "order.dated" } })).toBe(1);
  }, 60_000);

  it("a future day on the counter is stored; a same-day date writes no audit row", async () => {
    const productId = await product(false);
    const ahead = await ring(productId, addDays(today, 7));
    const row = await raw.order.findUniqueOrThrow({ where: { id: ahead.id } });
    expect(row.orderDate?.toISOString()).toBe(`${addDays(today, 7)}T00:00:00.000Z`);
    const before = await raw.auditLog.count({ where: { tenantId, action: "order.dated" } });
    await ring(productId, today);
    expect(await raw.auditLog.count({ where: { tenantId, action: "order.dated" } })).toBe(before);
  }, 60_000);

  describe("a LOCKED regulated month", () => {
    beforeAll(async () => {
      const [y, m] = lockedMonth.split("-").map(Number);
      await raw.regulatedFiling.create({
        data: {
          tenantId,
          trackedCategoryId: categoryId,
          reportTemplate: "GENERIC",
          cadence: "MONTHLY",
          periodKey: lockedMonth,
          periodStart: new Date(Date.UTC(y, m - 1, 1)),
          periodEnd: new Date(Date.UTC(y, m, 1)),
          status: "LOCKED",
          rows: [],
          lockedAt: new Date(),
          lockReason: "test",
        } as any,
      });
    });

    it("R15: a regulated line is refused 409 ORDER_DATE_PERIOD_LOCKED with nothing written", async () => {
      const productId = await product(true);
      const ordersBefore = await raw.order.count({ where: { tenantId } });
      const err: any = await ring(productId, threeBack).catch((e) => e);
      expect(err.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        code: "ORDER_DATE_PERIOD_LOCKED",
        periodKey: lockedMonth,
        categoryName: "Tobacco",
      });
      expect(await raw.order.count({ where: { tenantId } })).toBe(ordersBefore);
      const after = await raw.product.findUniqueOrThrow({ where: { id: productId } });
      expect(Number(after.currentStock)).toBe(100);
      expect(await raw.stockMovement.count({ where: { productId } })).toBe(0);
    }, 60_000);

    it("R16 (guard): a cart with no regulated line is created in the same month", async () => {
      const productId = await product(false);
      const order = await ring(productId, threeBack);
      expect(order.id).toBeDefined();
    }, 60_000);
  });
});
