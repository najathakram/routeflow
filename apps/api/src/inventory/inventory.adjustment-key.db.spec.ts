/**
 * B1415 M1b (SA-1404 M1 / SA-1504): POST /inventory/movements/adjustment replays an Idempotency-Key, on a REAL Postgres.
 * SA-A's seven cases, each red on master (master has no key: a retried adjustment writes a second movement):
 *
 *  (1) the same key twice in series: ONE ADJUSTMENT movement, ONE stock move, an identical response;
 *  (2) two concurrent requests with the same key: ONE movement (the key lock serializes them);
 *  (3) the same key on a second tenant: applies (the key is per tenant);
 *  (4) the same key with a different body: 409 IDEMPOTENCY_KEY_REUSED, nothing more written;
 *  (5) no key: applies as today (and again on a repeat, the legacy door);
 *  (6) a replay after its period was filed returns the stored result (the date gate runs after the read);
 *  (7) a forced 40P01 mid-transaction: the retry re-runs lock, check and apply, and ONE movement commits.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * Every tenant is a throwaway `qa-adjkey-*` slug (assertTestTenant), acme data. The `IdempotencyKey` rows the cases
 * leave behind are keyed by a random UUID hash in a global table (no tenant column) and age out with the 24h window.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { IdempotencyService } from "../common/idempotency.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-adjkey-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "inventory.adjustment-key.db.spec.ts",
  );
};

const today = new Date();
const monthStart = (back: number) =>
  new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1));
const FILED_START = monthStart(1);
const FILED_END_EXCL = monthStart(0);
const IN_FILED_MONTH = new Date(
  Date.UTC(FILED_START.getUTCFullYear(), FILED_START.getUTCMonth(), 15, 10),
);

const asJson = (v: unknown) => JSON.parse(JSON.stringify(v));

describeDb("Adjustment Idempotency-Key: real Postgres (B1415 M1b)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: InventoryService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        IdempotencyService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    service = module.get(InventoryService);
  }, 120_000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.stockLot.deleteMany({ where: { tenantId } });
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
    await prisma.tobaccoReport.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  interface World {
    tenantId: string;
    userId: string;
    productId: string;
  }

  async function seedWorld(label: string, opts: { tobacco?: boolean } = {}): Promise<World> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `Acme ${slug}` } });
    createdTenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    const product = await prisma.product.create({
      data: {
        name: "Acme Widget",
        unit: "ea",
        pricePerUnit: 10,
        currentStock: 100,
        averageCost: 2,
        costingMethod: "AVCO",
        isTobacco: opts.tobacco ?? false,
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, userId: user.id, productId: product.id };
  }

  const dto = (w: World, extra: Record<string, unknown> = {}) =>
    ({ productId: w.productId, quantity: 5, reason: "COUNT_CORRECTION", ...extra }) as never;

  const adjust = (w: World, extra: Record<string, unknown> = {}, key?: string) =>
    tenantCtx.run(w.tenantId, () => service.recordAdjustment(dto(w, extra), w.userId, key));

  const movements = (w: World) =>
    prisma.stockMovement.findMany({ where: { tenantId: w.tenantId, type: "ADJUSTMENT" } });
  const stockOf = async (w: World) =>
    Number((await prisma.product.findUniqueOrThrow({ where: { id: w.productId } })).currentStock);

  it("(1) the same key twice in series: one ADJUSTMENT, one stock move, an identical response", async () => {
    const w = await seedWorld("c1");
    const key = `c1-${randomUUID()}`;
    const first = await adjust(w, {}, key);
    const second = await adjust(w, {}, key);
    expect(asJson(second)).toEqual(asJson(first));
    expect(await movements(w)).toHaveLength(1);
    expect(await stockOf(w)).toBe(105);
    expect(await prisma.stockLot.count({ where: { tenantId: w.tenantId } })).toBe(1);
  }, 60_000);

  it("(2) two concurrent requests with the same key: one movement", async () => {
    const w = await seedWorld("c2");
    const key = `c2-${randomUUID()}`;
    const [a, b] = await Promise.all([adjust(w, {}, key), adjust(w, {}, key)]);
    expect(asJson(b)).toEqual(asJson(a));
    expect(await movements(w)).toHaveLength(1);
    expect(await stockOf(w)).toBe(105);
  }, 60_000);

  it("(3) the same key on a second tenant applies: the key is per tenant", async () => {
    const a = await seedWorld("c3a");
    const b = await seedWorld("c3b");
    const key = `c3-${randomUUID()}`;
    await adjust(a, {}, key);
    await adjust(b, {}, key);
    expect(await movements(a)).toHaveLength(1);
    expect(await movements(b)).toHaveLength(1);
    expect(await stockOf(a)).toBe(105);
    expect(await stockOf(b)).toBe(105);
  }, 60_000);

  it("(4) the same key with a different body: 409 IDEMPOTENCY_KEY_REUSED and nothing more is written", async () => {
    const w = await seedWorld("c4");
    const key = `c4-${randomUUID()}`;
    await adjust(w, {}, key);
    const err: any = await adjust(w, { quantity: 6 }, key).catch((e) => e);
    expect(err?.getStatus?.()).toBe(409);
    expect(err?.getResponse?.()).toMatchObject({ code: API_ERROR_CODES.IDEMPOTENCY_KEY_REUSED });
    expect(await movements(w)).toHaveLength(1);
    expect(await stockOf(w)).toBe(105);
    expect(await prisma.stockLot.count({ where: { tenantId: w.tenantId } })).toBe(1);
  }, 60_000);

  it("(5) no key applies as today, every time (the legacy door)", async () => {
    const w = await seedWorld("c5");
    await adjust(w);
    await adjust(w);
    expect(await movements(w)).toHaveLength(2);
    expect(await stockOf(w)).toBe(110);
  }, 60_000);

  it("(6) a replay after the period was filed returns the stored result; a new key is refused", async () => {
    const w = await seedWorld("c6", { tobacco: true });
    const key = `c6-${randomUUID()}`;
    const body = { effectiveDate: IN_FILED_MONTH.toISOString() };
    const first = await adjust(w, body, key); // the month is still open: a backdated write is allowed
    await prisma.tobaccoReport.create({
      data: {
        tenantId: w.tenantId,
        periodYear: FILED_START.getUTCFullYear(),
        periodMonth: FILED_START.getUTCMonth() + 1,
        periodStart: FILED_START,
        periodEnd: new Date(FILED_END_EXCL.getTime() - 1),
        status: "GENERATED",
        rows: [],
      } as any,
    });
    const replay = await adjust(w, body, key); // its month is filed now: the stored result still returns
    expect(asJson(replay)).toEqual(asJson(first));
    const refused: any = await adjust(w, body, `c6-new-${randomUUID()}`).catch((e) => e);
    expect(refused?.getStatus?.()).toBe(409);
    expect(refused?.getResponse?.()).toMatchObject({
      code: API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD,
    });
    expect(await movements(w)).toHaveLength(1);
    expect(await stockOf(w)).toBe(105);
  }, 60_000);

  it("(7) a forced 40P01 mid-transaction: the retry re-runs lock, check and apply, and one movement commits", async () => {
    const w = await seedWorld("c7");
    const key = `c7-${randomUUID()}`;
    const real = prisma.tenantTransaction.bind(prisma);
    let attempts = 0;
    jest.spyOn(prisma, "tenantTransaction").mockImplementation(((fn: any, opts?: any) => {
      attempts += 1;
      const mine = attempts;
      return real(async (tx: any) => {
        const out = await fn(tx); // the whole body ran: movement, lot, stock and the saved key
        if (mine === 1) {
          throw Object.assign(new Error("deadlock detected"), { code: "40P01" }); // Postgres rolls it all back
        }
        return out;
      }, opts);
    }) as never);
    await adjust(w, {}, key);
    expect(attempts).toBe(2);
    expect(await movements(w)).toHaveLength(1);
    expect(await stockOf(w)).toBe(105);
    // and the committed attempt's key now replays
    jest.restoreAllMocks();
    await adjust(w, {}, key);
    expect(await movements(w)).toHaveLength(1);
  }, 60_000);
});
