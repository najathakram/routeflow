/**
 * Row 718 — OrdersService.create() on real Postgres: a requestedDeliveryDate before the TENANT's today
 * (its TenantConfig.timezone) is refused 400 DELIVERY_DATE_IN_PAST and writes NOTHING; today passes and the
 * stored day is the day sent. Two tenants whose zones are 25 hours apart (UTC+14 and UTC-11) have different
 * calendar days at every instant, so the assertions hold at any wall-clock time without freezing the clock:
 * the day that is "today" for the eastern tenant is still in the FUTURE for the western one, and the western
 * tenant's today is already in the PAST for the eastern one.
 *
 * Test tenants only (assertTestTenant); run via `npm run local:test:db` or jest.db.config.js.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { EncryptionService } from "../common/encryption.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { OrdersService } from "./orders.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const EAST = "Pacific/Kiritimati"; // UTC+14
const WEST = "Pacific/Pago_Pago"; // UTC-11

/** The calendar day (YYYY-MM-DD) it is in `zone` right now, shifted by whole days. */
const dayIn = (zone: string, offsetDays = 0): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86_400_000)); // en-CA formats as YYYY-MM-DD

interface Fixture {
  tenantId: string;
  slug: string;
  operatorId: string;
  customerUserId: string;
  customerId: string;
  productId: string;
}

describeDb("row 718 — create() refuses a past delivery day on the tenant's calendar", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const fixtures = {} as Record<"east" | "west", Fixture>;

  const staff = (f: Fixture): JwtPayload =>
    ({
      sub: f.operatorId,
      username: "operator",
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: f.tenantId,
      tenantSlug: f.slug,
    }) as JwtPayload;

  async function makeFixture(label: string, timezone: string): Promise<Fixture> {
    const slug = assertTestTenant(
      `qa-r718${label}-${run}`,
      "orders.delivery-date-guard.db.spec.ts",
    );
    const tenant = await raw.tenant.create({ data: { slug, name: `R718 ${slug}` } });
    await raw.tenantConfig.create({ data: { tenantId: tenant.id, timezone } });
    const op = await raw.user.create({
      data: {
        email: `op-${label}-${run}@example.test`,
        username: `op-${label}-${run}`,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    const cu = await raw.user.create({
      data: {
        email: `c-${label}-${run}@example.test`,
        username: `c-${label}-${run}`,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await raw.customer.create({
      data: {
        userId: cu.id,
        businessName: `r718 ${label} co`,
        contactName: "Tester",
        tenantId: tenant.id,
      },
    });
    const product = await raw.product.create({
      data: {
        name: `Widget ${label} ${run}`,
        unit: "each",
        pricePerUnit: "2.50",
        currentStock: 1000,
        tenantId: tenant.id,
      },
    });
    return {
      tenantId: tenant.id,
      slug,
      operatorId: op.id,
      customerUserId: cu.id,
      customerId: customer.id,
      productId: product.id,
    };
  }

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
      invoicesService: {},
      logger: new Logger(OrdersService.name),
    });
    fixtures.east = await makeFixture("e", EAST);
    fixtures.west = await makeFixture("w", WEST);
  }, 120_000);

  afterAll(async () => {
    for (const f of Object.values(fixtures)) {
      if (!f) continue;
      const ids = (
        await raw.order.findMany({ where: { tenantId: f.tenantId }, select: { id: true } })
      ).map((o) => o.id);
      await raw.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
      await raw.stockMovement.deleteMany({ where: { productId: f.productId } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: ids } } });
      await raw.order.deleteMany({ where: { id: { in: ids } } });
      await raw.product.deleteMany({ where: { id: f.productId } });
      await raw.customer.deleteMany({ where: { id: f.customerId } });
      await raw.systemConfig.deleteMany({ where: { tenantId: f.tenantId } });
      await raw.tenantConfig.deleteMany({ where: { tenantId: f.tenantId } });
      await raw.user.deleteMany({ where: { id: { in: [f.operatorId, f.customerUserId] } } });
      await raw.tenant.deleteMany({ where: { id: f.tenantId } });
    }
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  const place = (f: Fixture, requestedDeliveryDate?: string) =>
    tenantCtx.run(f.tenantId, () =>
      orders.create(
        {
          customerId: f.customerId,
          items: [{ productId: f.productId, qty: 1 }],
          ...(requestedDeliveryDate ? { requestedDeliveryDate } : {}),
        } as never,
        staff(f),
        { skipAutoMerge: true },
      ),
    );
  const failed = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e) => e,
    );
  const countOrders = (f: Fixture) => raw.order.count({ where: { tenantId: f.tenantId } });

  it("the two tenants really are on different calendar days right now", () => {
    expect(dayIn(EAST) > dayIn(WEST)).toBe(true);
  });

  it("refuses the tenant's yesterday with 400 DELIVERY_DATE_IN_PAST and writes no order", async () => {
    for (const [f, zone] of [
      [fixtures.east, EAST],
      [fixtures.west, WEST],
    ] as const) {
      const before = await countOrders(f);
      const err = await failed(place(f, dayIn(zone, -1)));
      expect(err?.getStatus()).toBe(400);
      expect(err.getResponse()).toMatchObject({
        code: "DELIVERY_DATE_IN_PAST",
        today: dayIn(zone),
      });
      expect(await countOrders(f)).toBe(before);
    }
  }, 60_000);

  it("accepts the tenant's today and stores that day", async () => {
    for (const [f, zone] of [
      [fixtures.east, EAST],
      [fixtures.west, WEST],
    ] as const) {
      const created = await place(f, dayIn(zone));
      const row = await raw.order.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.requestedDeliveryDate?.toISOString().slice(0, 10)).toBe(dayIn(zone));
    }
  }, 60_000);

  it("the day is the TENANT's, not UTC's: the western tenant's today is already past in the east, and the east's today is still ahead in the west", async () => {
    const eastErr = await failed(place(fixtures.east, dayIn(WEST)));
    expect(eastErr?.getResponse()).toMatchObject({ code: "DELIVERY_DATE_IN_PAST" });
    const created = await place(fixtures.west, dayIn(EAST));
    expect(created.id).toBeTruthy();
  }, 60_000);

  it("no requestedDeliveryDate: the order is created as before", async () => {
    const created = await place(fixtures.west);
    const row = await raw.order.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.requestedDeliveryDate).toBeNull();
  }, 60_000);
});
