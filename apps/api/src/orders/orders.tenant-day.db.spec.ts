/**
 * Row 735 — the TENANT's day end to end, on real Postgres. A tenant in Pacific/Honolulu (UTC-10) and one in
 * America/Chicago (the 2026-11-01 fall-back day is 25 hours long) are driven at fixed instants (only `Date` is
 * faked) through OrdersService.create() and createSale():
 *  (c) an Idempotency-Key REPLAY of an order created with a day that has since passed on the tenant's calendar
 *      returns the original order (nothing new is written, no 400) - the guard still refuses a fresh request;
 *  (b) the sale delivery picker (`deliveredOn`) decides delivered-vs-scheduled on the tenant's day, not UTC's.
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

const HONOLULU = "Pacific/Honolulu"; // UTC-10, no DST
const CHICAGO = "America/Chicago"; // CDT (-5) until 2026-11-01 02:00, then CST (-6)

/** Only `Date` is faked: the pg pool and Prisma keep their real timers. */
const ONLY_DATE = [
  "hrtime",
  "nextTick",
  "performance",
  "queueMicrotask",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "setImmediate",
  "clearImmediate",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
] as const;
const at = (iso: string) => {
  jest.useFakeTimers({ now: new Date(iso), doNotFake: [...ONLY_DATE] });
};

interface Fixture {
  tenantId: string;
  slug: string;
  operatorId: string;
  customerUserId: string;
  customerId: string;
  productId: string;
}

describeDb("row 735 — the tenant's day end to end (create, replay, sale picker)", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const fixtures = {} as Record<"hnl" | "chi", Fixture>;

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
    const slug = assertTestTenant(`qa-r735${label}-${run}`, "orders.tenant-day.db.spec.ts");
    const tenant = await raw.tenant.create({ data: { slug, name: `R735 ${slug}` } });
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
        businessName: `r735 ${label} co`,
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
      // createSale's invoice step is not under test: a draft per sale, sent on request
      invoicesService: {
        createInvoiceFromOrder: async (orderId: string) => [
          { id: `inv-${orderId}`, status: "DRAFT" },
        ],
        send: async (id: string) => ({ id, status: "SENT" }),
      },
      logger: new Logger(OrdersService.name),
    });
    fixtures.hnl = await makeFixture("h", HONOLULU);
    fixtures.chi = await makeFixture("c", CHICAGO);
  }, 120_000);

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(async () => {
    jest.useRealTimers();
    for (const f of Object.values(fixtures)) {
      if (!f) continue;
      const ids = (
        await raw.order.findMany({ where: { tenantId: f.tenantId }, select: { id: true } })
      ).map((o) => o.id);
      await raw.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
      await raw.stockMovement.deleteMany({ where: { productId: f.productId } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: ids } } });
      await raw.orderIdempotencyKey.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
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

  const body = (f: Fixture) => ({
    customerId: f.customerId,
    items: [{ productId: f.productId, qty: 1 }],
  });
  const place = (f: Fixture, extra: Record<string, unknown> = {}) =>
    tenantCtx.run(f.tenantId, () =>
      orders.create({ ...body(f), ...extra } as never, staff(f), { skipAutoMerge: true }),
    );
  const sell = (f: Fixture, extra: Record<string, unknown>) =>
    tenantCtx.run(f.tenantId, () =>
      orders.createSale({ ...body(f), deliveredNow: false, ...extra } as never, staff(f)),
    );
  const failed = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e) => e,
    );
  const countOrders = (f: Fixture) => raw.order.count({ where: { tenantId: f.tenantId } });
  const row = (id: string) => raw.order.findUniqueOrThrow({ where: { id } });
  const day = (d: Date | null) => d?.toISOString().slice(0, 10);

  describe("(c) an Idempotency-Key replay of an order whose day has since passed replays", () => {
    it("create(), Honolulu: created on the tenant's 21st with the 21st, replayed on the 22nd, returns the original", async () => {
      const f = fixtures.hnl;
      const key = `k735-create-${run}`;
      at("2026-10-22T05:00:00Z"); // 19:00 on the 21st in Honolulu (already the 22nd in UTC)
      const first = await place(f, { requestedDeliveryDate: "2026-10-21", idempotencyKey: key });
      expect(day((await row(first.id)).requestedDeliveryDate)).toBe("2026-10-21");
      const before = await countOrders(f);

      at("2026-10-22T11:00:00Z"); // 01:00 on the 22nd in Honolulu: the 21st has passed
      const replay = await place(f, { requestedDeliveryDate: "2026-10-21", idempotencyKey: key });
      expect(replay.id).toBe(first.id);
      expect(await countOrders(f)).toBe(before);

      // the guard still binds a request that is not a replay
      const err = await failed(
        place(f, { requestedDeliveryDate: "2026-10-21", idempotencyKey: `${key}-fresh` }),
      );
      expect(err?.getResponse()).toMatchObject({
        code: "DELIVERY_DATE_IN_PAST",
        today: "2026-10-22",
      });
      expect(await countOrders(f)).toBe(before);
    }, 60_000);

    it("createSale, Honolulu: a requested delivery day of the tenant's 21st, replayed on the 22nd, returns the same order", async () => {
      const f = fixtures.hnl;
      const key = `k735-sale-${run}`;
      at("2026-10-22T05:00:00Z");
      await sell(f, { requestedDeliveryDate: "2026-10-21", idempotencyKey: key });
      const [created] = await raw.order.findMany({
        where: { tenantId: f.tenantId, idempotencyKey: key },
      });
      expect(created).toBeTruthy();
      const before = await countOrders(f);

      at("2026-10-22T11:00:00Z");
      await expect(
        sell(f, { requestedDeliveryDate: "2026-10-21", idempotencyKey: key }),
      ).resolves.toBeDefined();
      expect(await countOrders(f)).toBe(before);
    }, 60_000);

    it("createSale, Chicago fall-back: a deliveredOn of 11-01 sold at 23:30 CST, replayed after local midnight, returns the same order", async () => {
      const f = fixtures.chi;
      const key = `k735-sale-dst-${run}`;
      at("2026-11-02T05:30:00Z"); // 23:30 CST on 11-01 (a fixed CDT offset would call it 00:30 on 11-02)
      await sell(f, { deliveredOn: "2026-11-01", idempotencyKey: key });
      const created = await raw.order.findFirstOrThrow({
        where: { tenantId: f.tenantId, idempotencyKey: key },
      });
      expect(created.status).toBe("DELIVERED");
      expect(day(created.deliveredAt)).toBe("2026-11-01");
      const before = await countOrders(f);

      at("2026-11-02T06:30:00Z"); // 00:30 CST on 11-02
      await expect(
        sell(f, { deliveredOn: "2026-11-01", idempotencyKey: key }),
      ).resolves.toBeDefined();
      expect(await countOrders(f)).toBe(before);
    }, 60_000);
  });

  describe("(b) the sale picker (deliveredOn) is judged on the tenant's day", () => {
    it("Honolulu at 05:00Z on the 22nd (19:00 on the 21st): deliveredOn the 22nd is TOMORROW there, so the order is scheduled, not delivered", async () => {
      const f = fixtures.hnl;
      at("2026-10-22T05:00:00Z");
      await sell(f, { deliveredOn: "2026-10-22", idempotencyKey: `k735-hnl-sched-${run}` });
      const order = await raw.order.findFirstOrThrow({
        where: { tenantId: f.tenantId, idempotencyKey: `k735-hnl-sched-${run}` },
      });
      expect(order.status).toBe("PENDING");
      expect(day(order.requestedDeliveryDate)).toBe("2026-10-22");
      expect(order.deliveredAt).toBeNull();
    }, 60_000);

    it("Honolulu on the tenant's own today (the 21st): delivered on that day", async () => {
      const f = fixtures.hnl;
      at("2026-10-22T05:00:00Z");
      await sell(f, { deliveredOn: "2026-10-21", idempotencyKey: `k735-hnl-today-${run}` });
      const order = await raw.order.findFirstOrThrow({
        where: { tenantId: f.tenantId, idempotencyKey: `k735-hnl-today-${run}` },
      });
      expect(order.status).toBe("DELIVERED");
      expect(day(order.deliveredAt)).toBe("2026-10-21");
    }, 60_000);

    it("Chicago on the 25-hour fall-back day: 11-01 delivers and 11-02 schedules at 23:30 CST; at 00:30 CST 11-02 delivers", async () => {
      const f = fixtures.chi;
      at("2026-11-02T05:30:00Z");
      await sell(f, { deliveredOn: "2026-11-02", idempotencyKey: `k735-chi-sched-${run}` });
      const scheduled = await raw.order.findFirstOrThrow({
        where: { tenantId: f.tenantId, idempotencyKey: `k735-chi-sched-${run}` },
      });
      expect(scheduled.status).toBe("PENDING");
      expect(day(scheduled.requestedDeliveryDate)).toBe("2026-11-02");

      at("2026-11-02T06:30:00Z");
      await sell(f, { deliveredOn: "2026-11-02", idempotencyKey: `k735-chi-deliv-${run}` });
      const delivered = await raw.order.findFirstOrThrow({
        where: { tenantId: f.tenantId, idempotencyKey: `k735-chi-deliv-${run}` },
      });
      expect(delivered.status).toBe("DELIVERED");
      expect(day(delivered.deliveredAt)).toBe("2026-11-02");
    }, 60_000);
  });

  describe("the guard across the DST transition (Chicago, 2026-11-01)", () => {
    it("accepts 11-01 at 23:30 CST and refuses it at 00:30 CST on the 2nd", async () => {
      const f = fixtures.chi;
      at("2026-11-02T05:30:00Z");
      const ok = await place(f, { requestedDeliveryDate: "2026-11-01" });
      expect(day((await row(ok.id)).requestedDeliveryDate)).toBe("2026-11-01");
      const before = await countOrders(f);

      at("2026-11-02T06:30:00Z");
      const err = await failed(place(f, { requestedDeliveryDate: "2026-11-01" }));
      expect(err?.getResponse()).toMatchObject({
        code: "DELIVERY_DATE_IN_PAST",
        today: "2026-11-02",
      });
      expect(await countOrders(f)).toBe(before);
    }, 60_000);
  });

  describe("the guard for a UTC-10 tenant (Honolulu)", () => {
    it("at 05:00Z on the 22nd the tenant is on the 21st: the 21st passes, the 20th is refused", async () => {
      const f = fixtures.hnl;
      at("2026-10-22T05:00:00Z");
      const ok = await place(f, { requestedDeliveryDate: "2026-10-21" });
      expect(day((await row(ok.id)).requestedDeliveryDate)).toBe("2026-10-21");
      const err = await failed(place(f, { requestedDeliveryDate: "2026-10-20" }));
      expect(err?.getResponse()).toMatchObject({
        code: "DELIVERY_DATE_IN_PAST",
        today: "2026-10-21",
      });
    }, 60_000);
  });
});
