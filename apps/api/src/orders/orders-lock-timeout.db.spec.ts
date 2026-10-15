// Mock InvoicesService / NotificationsService before they are imported: their module graphs pull in
// ESM-only packages (@react-pdf/renderer, expo-server-sdk) that Jest's CommonJS parser rejects.
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: class InvoicesService {},
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: class NotificationsService {},
}));

/**
 * SA-767 r-note 3 (b), L-2.3 - real-Postgres proof that a SALE behind a held Product row lock is not an
 * uncoded 500. The real `OrdersService.create` (real PrismaService, real `decrementStockForSale`, real
 * `lockProductsForStock` with its SET LOCAL lock_timeout = 5s) runs against a separate connection that
 * holds the product row FOR UPDATE:
 *
 *  (1) the holder keeps the row past all 3 attempts (3 x 5 s lock waits): the sale is the coded 503
 *      LOCK_UNAVAILABLE (retryStockTx exhaustion; the global filter is the second line), and NOTHING is
 *      written - no order, no SALE movement, the counter untouched. On the branch before L-2.3 this was a
 *      raw 55P03 (an uncoded 500). ~16 s by construction (3 x the 5 s STOCK_LOCK_TIMEOUT), accepted once.
 *  (2) the holder releases during retry 2: the same sale answers 2xx with exactly ONE order and ONE SALE
 *      movement, the counter down by the sale once.
 *
 * `sawLockWait(holderPid)` only counts a backend blocked BY the holder's connection, so another DB lane
 * waiting on its own locks in the same database cannot fake the observation (the B916 rule: the wait is
 * observed, not assumed).
 *
 * Collected only by `jest.db.config.js` (`npm run test:db -w apps/api`); `requireLocalDatabaseUrl()` refuses
 * any non-local host. Tenants are throwaway `qa-sa767-l23-<run>` slugs approved by `assertTestTenant`.
 */
import { randomUUID } from "crypto";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";
import { OrdersService } from "./orders.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { PromotionsService } from "../promotions/promotions.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { PolicyOversellReader } from "./policy-oversell-reader";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

describeDb("SA-767 r-note 3 (b) - a sale behind a held product lock (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: OrdersService;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  const holders: PoolClient[] = [];
  let seq = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const explicit = new Map<unknown, unknown>([
      [PrismaService, prisma],
      [TenantContextService, tenantCtx],
      [PolicyOversellReader, { read: async () => "off" }],
      [ConfigService, { get: jest.fn().mockReturnValue(0.1) }],
      [EntitlementsService, { hasFlag: jest.fn().mockResolvedValue(false) }],
      [getQueueToken("invoices"), { add: jest.fn() }],
      [SystemConfigService, { get: jest.fn().mockResolvedValue(null) }],
      [
        SellingRestrictionsService,
        {
          assertLinesSellable: jest.fn().mockResolvedValue(undefined),
          checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "OFF", reasons: [] }),
          getPolicy: jest.fn().mockResolvedValue({ enabled: false }),
        },
      ],
      [
        AuthorizationGuardService,
        {
          assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
          checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
        },
      ],
      [PromotionsService, { activeForCatalog: jest.fn().mockResolvedValue([]) }],
      [
        CreditNotesService,
        {
          validateSelectionsForCustomer: jest.fn().mockResolvedValue(undefined),
          syncOrderCreditSelections: jest.fn().mockResolvedValue(undefined),
        },
      ],
    ]);
    const module = await Test.createTestingModule({ providers: [OrdersService] })
      .useMocker((token) => (explicit.has(token) ? explicit.get(token) : autoMock()))
      .compile();
    orders = module.get(OrdersService);
  }, 120_000);

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const h of holders.splice(0)) {
      // eslint-disable-next-line no-await-in-loop
      await h.query("ROLLBACK").catch(() => undefined);
      h.release();
    }
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      /* eslint-disable no-await-in-loop */
      for (const del of [
        () => prisma.stockMovement.deleteMany({ where: { tenantId } }),
        () => prisma.orderItem.deleteMany({ where: { tenantId } }),
        () => prisma.order.deleteMany({ where: { tenantId } }),
        () => prisma.product.deleteMany({ where: { tenantId } }),
        () => prisma.customer.deleteMany({ where: { tenantId } }),
        () => prisma.user.deleteMany({ where: { tenantId } }),
        () => prisma.tenant.deleteMany({ where: { id: tenantId } }),
      ]) {
        await del().catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`SA-767 L-2.3 spec cleanup failed for tenant ${tenantId}:`, e);
        });
      }
      /* eslint-enable no-await-in-loop */
    }
    await prisma?.$disconnect();
    await pool?.end();
  }, 120_000);

  async function seedWorld(label: string, stock: number) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa767-l23-${run}-${seq}-${label}`,
      "orders-lock-timeout.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA-767 L-2.3 ${slug}` } });
    tenantIds.push(tenant.id);
    const staff = await prisma.user.create({
      data: {
        email: `${slug}-op@example.invalid`,
        username: `${slug}-op`,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    const buyer = await prisma.user.create({
      data: {
        email: `${slug}-c@example.invalid`,
        username: `${slug}-c`,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: buyer.id,
        businessName: "Acme Buyer",
        contactName: "A. Buyer",
        tenantId: tenant.id,
      },
    });
    const product = await prisma.product.create({
      data: {
        name: `Widget ${slug}`,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: stock,
        tenantId: tenant.id,
      },
    });
    const principal = {
      sub: staff.id,
      username: staff.username,
      role: "OPERATOR" as const,
      status: "ACTIVE" as const,
      forcePasswordChange: false,
      tenantId: tenant.id,
    };
    return { tenantId: tenant.id, customerId: customer.id, productId: product.id, principal };
  }
  type World = Awaited<ReturnType<typeof seedWorld>>;

  /** A separate connection that holds the product row FOR UPDATE until `release`. */
  async function holdProduct(w: World) {
    const holder = await pool.connect();
    holders.push(holder);
    await holder.query("BEGIN");
    await holder.query('SELECT id FROM "Product" WHERE id = $1 FOR UPDATE', [w.productId]);
    const pid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    return {
      pid,
      release: async () => {
        await holder.query("ROLLBACK");
      },
    };
  }

  /** True once a backend is genuinely WAITING on a lock held by `holderPid`. */
  async function sawLockWait(holderPid: number, withinMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND pg_blocking_pids(pid) @> ARRAY[$1::int]`,
        [holderPid],
      );
      if (rows[0].n > 0) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(25);
    }
    return false;
  }

  const sale = (w: World) =>
    tenantCtx.run(w.tenantId, () =>
      orders.create(
        { customerId: w.customerId, items: [{ productId: w.productId, qty: 2 }] } as never,
        w.principal as never,
      ),
    );
  const written = async (w: World) => ({
    orders: await prisma.order.count({ where: { tenantId: w.tenantId } }),
    movements: await prisma.stockMovement.count({ where: { tenantId: w.tenantId } }),
    stock: Number(
      (await prisma.product.findUniqueOrThrow({ where: { id: w.productId } })).currentStock,
    ),
  });

  it("(1) the holder outlasts every attempt: the sale is the coded 503 LOCK_UNAVAILABLE and nothing is written", async () => {
    const w = await seedWorld("exhaust", 10);
    const holder = await holdProduct(w);

    const outcome = sale(w).then(
      (v) => ({ v }),
      (err) => ({ err }),
    );
    expect(await sawLockWait(holder.pid)).toBe(true); // the sale is genuinely blocked on the holder
    const settled: any = await outcome; // ~3 x 5 s: three lock_timeout waits, then the 503
    await holder.release();

    expect(settled.v).toBeUndefined();
    expect(settled.err?.getStatus?.()).toBe(503);
    expect(settled.err?.getResponse?.()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
    expect(await written(w)).toEqual({ orders: 0, movements: 0, stock: 10 });
  }, 90_000);

  it("(2) the holder releases during retry 2: the same sale answers 2xx with exactly one order and one SALE row", async () => {
    const w = await seedWorld("frees", 10);
    const holder = await holdProduct(w);
    const retryLogs: string[] = [];
    const warn = Logger.prototype.warn as unknown as (m: unknown) => void;
    jest.spyOn(Logger.prototype, "warn").mockImplementation(function (this: unknown, m: unknown) {
      retryLogs.push(String(m));
      return warn.call(this, m);
    } as never);

    const outcome = sale(w).then(
      (v) => ({ v }),
      (err) => ({ err }),
    );
    expect(await sawLockWait(holder.pid)).toBe(true);
    // Attempt 1 gives up after its 5 s lock_timeout and retries; free the row while attempt 2 waits.
    await sleep(6_500);
    await holder.release();
    const settled: any = await outcome;

    expect(settled.err).toBeUndefined();
    expect(settled.v?.id).toBeDefined();
    expect(retryLogs.some((m) => /55P03.*retry 2\/3/.test(m))).toBe(true); // it DID retry
    expect(await written(w)).toEqual({ orders: 1, movements: 1, stock: 8 });
  }, 90_000);
});
