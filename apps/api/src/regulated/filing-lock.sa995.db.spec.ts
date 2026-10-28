/**
 * SA-995 — the regulated filing lock, real Postgres. A filing locks only if its stored figures still equal the
 * ledger's (409 FILING_STALE, decided after the claim), a ledger writer's guard holds a FOR SHARE row lock the claim
 * must wait for, and "the period has ended" is the tenant's own day with no grace.
 *
 * Rows L1-L7 are the red rows of SA-995. L4 and L5 use two real connections: a writer transaction paused after its
 * guard, and a Serializable writer whose snapshot precedes the claim (the 40001 it gets is logged for the report).
 * The cron rows watch the daily auto-prepare retry a period that has not yet ended for a US tenant.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`). The tenant is a throwaway `qa-b297s-<run>` slug approved by
 * `assertTestTenant`; `afterAll` deletes exactly the rows this run created.
 */
jest.mock("./filing-lock-ready", () => ({
  ...jest.requireActual("./filing-lock-ready"),
  assertFilingLockReady: () => undefined, // SA-997: this spec exercises the lock itself
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { RegulatedService } from "./regulated.service";
import { RegulatedFilingService } from "./regulated-filing.service";
import { RegulatedFilingCronService } from "./regulated-filing-cron.service";
import { assertLedgerRowsNotLocked } from "./filing-lock";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

/** Fake only the clock: the pg driver and the lock pool keep their real timers. */
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
const freezeClock = (iso: string) =>
  jest.useFakeTimers({ now: new Date(iso), doNotFake: [...ONLY_DATE] });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Resolves "pending" when `p` has not settled within `ms`, else "settled". */
const stateAfter = (p: Promise<unknown>, ms: number) =>
  Promise.race([
    p.then(
      () => "settled",
      () => "settled",
    ),
    sleep(ms).then(() => "pending"),
  ]);

describeDb("SA-995 — the filing lock decides by figures, rows and the tenant's day", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-b297s-${run}`, "filing-lock.sa995.db.spec.ts");
  let tenantId = "";
  let operatorUserId = "";
  let categoryId = "";
  const warn = jest.spyOn(Logger.prototype, "warn");

  const inTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const storage = { upload: jest.fn().mockResolvedValue(undefined), presignedUrl: jest.fn() };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const filingService = () =>
    new (RegulatedFilingService as any)(
      prisma,
      storage,
      audit,
      new (RegulatedService as any)(prisma),
      {},
    );
  const prepare = (year: number, index: number) =>
    inTenant(() =>
      filingService().prepareFiling({
        trackedCategoryId: categoryId,
        cadence: "MONTHLY",
        year,
        index,
        userId: operatorUserId,
      }),
    );
  const lock = (id: string, impersonatedBy: string | null = null) =>
    inTenant(() =>
      filingService().lockFiling(id, {
        userId: operatorUserId,
        reason: "Filed with the state",
        impersonatedBy,
      }),
    );
  const filingOf = (id: string) => raw.regulatedFiling.findUniqueOrThrow({ where: { id } });
  const lockAudits = (id: string) =>
    raw.auditLog.count({ where: { tenantId, action: "regulated_filing.locked", entityId: id } });

  /** A SALE row as a committed writer leaves it. */
  const sale = (soldAt: string, bucket: string, netSales = 10) => ({
    tenantId,
    trackedCategoryId: categoryId,
    entryType: "SALE" as const,
    invoiceId: `inv-${randomUUID().slice(0, 6)}`,
    qty: 1,
    unitBasisQty: 1,
    netSales,
    categoryTax: 0,
    soldAt: new Date(soldAt),
    periodBucket: bucket,
  });
  const bookSale = (soldAt: string, bucket: string, netSales = 10) =>
    raw.regulatedSalesLedger.create({ data: sale(soldAt, bucket, netSales) });

  /** A GENERATED filing whose figures are exactly what the service computes now (what prepare stores). */
  async function generatedFiling(year: number, month: number) {
    const periodKey = `${year}-${String(month).padStart(2, "0")}`;
    const periodStart = new Date(Date.UTC(year, month - 1, 1));
    const periodEnd = new Date(Date.UTC(year, month, 1));
    const category = await raw.trackedCategory.findUniqueOrThrow({ where: { id: categoryId } });
    const figures: any = await inTenant<any>(() =>
      filingService().buildFilingFigures(category, {
        trackedCategoryId: categoryId,
        cadence: "MONTHLY",
        periodKey,
        buckets: [periodKey],
        from: periodStart,
        to: periodEnd,
      }),
    );
    return raw.regulatedFiling.create({
      data: {
        tenantId,
        trackedCategoryId: categoryId,
        reportTemplate: category.reportTemplate,
        cadence: "MONTHLY",
        periodKey,
        periodStart,
        periodEnd,
        status: "GENERATED",
        rows: figures.rowsJson,
        csvKey: "k.csv",
        totalQty: figures.totals.totalQty,
        totalUnitBasisQty: figures.totals.totalUnitBasisQty,
        totalNetSales: figures.totals.totalNetSales,
        totalCategoryTax: figures.totals.totalCategoryTax,
      } as any,
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    tenantId = (await raw.tenant.create({ data: { slug, name: `SA995 ${slug}` } })).id;
    await raw.tenantConfig.create({ data: { tenantId, timezone: "America/Chicago" } });
    await raw.tenantAddon.create({ data: { tenantId, addonKey: "tobacco_dealer", active: true } });
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
    categoryId = (
      await raw.trackedCategory.create({
        data: {
          tenantId,
          name: `Excise ${run}`,
          taxType: "EXCISE_PER_UNIT",
          rate: 0.05,
          priceIncludesTax: false,
        },
      })
    ).id;
  }, 120_000);

  beforeEach(async () => {
    jest.useRealTimers();
    warn.mockClear();
    storage.upload.mockClear();
    await raw.regulatedFiling.deleteMany({ where: { tenantId } });
    await raw.regulatedSalesLedger.deleteMany({ where: { tenantId } });
    await raw.auditLog.deleteMany({ where: { tenantId } });
  });

  afterAll(async () => {
    jest.useRealTimers();
    try {
      await raw.regulatedFiling.deleteMany({ where: { tenantId } });
      await raw.regulatedSalesLedger.deleteMany({ where: { tenantId } });
      await raw.auditLog.deleteMany({ where: { tenantId } });
      await raw.trackedCategory.deleteMany({ where: { tenantId } });
      await raw.tenantAddon.deleteMany({ where: { tenantId } });
      await raw.tenantConfig.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
    } finally {
      warn.mockRestore();
      await _resetLockPoolForTests();
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }
  }, 120_000);

  const SEPT = "2026-09";

  // ─── L1-L3: the compare ────────────────────────────────────────────────────────────────────────────────────
  it("L1: a sale booked after the filing was generated refuses the lock with 409 FILING_STALE", async () => {
    await bookSale("2026-09-05T15:00:00Z", SEPT);
    const filing: any = await prepare(2026, 9);
    await bookSale("2026-09-15T15:00:00Z", SEPT, 25); // a manual invoice issued 2026-09-15 with a regulated line
    await expect(lock(filing.id)).rejects.toMatchObject({
      status: 409,
      response: { code: "FILING_STALE" },
    });
    expect((await filingOf(filing.id)).status).toBe("GENERATED");
    expect(await lockAudits(filing.id)).toBe(0);
  }, 120_000);

  it("L2: regenerating after that sale, then locking, locks with the sale in the totals", async () => {
    await bookSale("2026-09-05T15:00:00Z", SEPT);
    const first: any = await prepare(2026, 9);
    await bookSale("2026-09-15T15:00:00Z", SEPT, 25);
    const again: any = await prepare(2026, 9);
    expect(again.id).toBe(first.id);
    expect(again.generationCount).toBe(2);
    const out: any = await lock(first.id);
    expect(out.status).toBe("LOCKED");
    expect(Number(out.totalNetSales)).toBe(35);
    expect(await lockAudits(first.id)).toBe(1);
  }, 120_000);

  it("L3: no ledger change since the filing locks, and the audit row carries the impersonator", async () => {
    await bookSale("2026-09-05T15:00:00Z", SEPT);
    await bookSale("2026-09-20T15:00:00Z", SEPT, 7.5);
    const filing: any = await prepare(2026, 9);
    const out: any = await lock(filing.id, "sa-user-1");
    expect(out.status).toBe("LOCKED");
    const row = await raw.auditLog.findFirst({
      where: { tenantId, action: "regulated_filing.locked", entityId: filing.id },
    });
    expect((row as any)?.impersonatedBy).toBe("sa-user-1");
  }, 120_000);

  it("the lock transaction runs at READ COMMITTED (the claim must see rows a waited-for writer committed)", async () => {
    const filing: any = await prepare(2026, 9);
    const seen: string[] = [];
    const original = prisma.tenantTransaction.bind(prisma);
    const spy = jest.spyOn(prisma, "tenantTransaction").mockImplementation((fn: any, opts?: any) =>
      original(async (tx: any) => {
        const r = await tx.$queryRaw`SHOW transaction_isolation`;
        seen.push(String(r[0].transaction_isolation));
        return fn(tx);
      }, opts),
    );
    try {
      await lock(filing.id);
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual(["read committed"]);
  }, 120_000);

  // ─── L4: the row lock ──────────────────────────────────────────────────────────────────────────────────────
  it("L4: a writer paused after its guard holds the claim off; the claim then sees the writer's row (FILING_STALE)", async () => {
    await bookSale("2026-09-05T15:00:00Z", SEPT);
    const filing: any = await prepare(2026, 9);
    let guardDone!: () => void;
    const guarded = new Promise<void>((r) => (guardDone = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const writer = inTenant(() =>
      prisma.tenantTransaction(async (tx: any) => {
        await assertLedgerRowsNotLocked(tx, [
          { trackedCategoryId: categoryId, periodBucket: SEPT },
        ]);
        guardDone();
        await gate;
        await tx.regulatedSalesLedger.create({ data: sale("2026-09-16T15:00:00Z", SEPT, 40) });
      }),
    );
    await guarded;
    const locking = lock(filing.id);
    locking.catch(() => undefined);
    expect(await stateAfter(locking, 1500)).toBe("pending"); // the claim waits for the writer's FOR SHARE
    release();
    await writer;
    await expect(locking).rejects.toMatchObject({ response: { code: "FILING_STALE" } });
    expect((await filingOf(filing.id)).status).toBe("GENERATED");
    expect(await lockAudits(filing.id)).toBe(0);
  }, 120_000);

  // ─── L5: the claim first ───────────────────────────────────────────────────────────────────────────────────
  it("L5: once the claim has committed, a READ COMMITTED writer gets LEDGER_PERIOD_LOCKED", async () => {
    const filing: any = await prepare(2026, 9);
    await lock(filing.id);
    await expect(
      inTenant(() =>
        prisma.tenantTransaction(async (tx: any) => {
          await assertLedgerRowsNotLocked(tx, [
            { trackedCategoryId: categoryId, periodBucket: SEPT },
          ]);
          await tx.regulatedSalesLedger.create({ data: sale("2026-09-16T15:00:00Z", SEPT) });
        }),
      ),
    ).rejects.toMatchObject({ response: { code: "LEDGER_PERIOD_LOCKED" } });
    expect(await raw.regulatedSalesLedger.count({ where: { tenantId } })).toBe(0);
  }, 120_000);

  it("L5: a Serializable writer whose snapshot precedes the claim fails to serialise (40001), writes nothing, and its retry gets LEDGER_PERIOD_LOCKED", async () => {
    const filing: any = await prepare(2026, 9);
    let snapshotTaken!: () => void;
    const snapshot = new Promise<void>((r) => (snapshotTaken = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const attempt = (serializable: boolean, paused: boolean) =>
      inTenant(() =>
        prisma.tenantTransaction(
          async (tx: any) => {
            await tx.regulatedSalesLedger.count(); // the writer's first statement: its snapshot starts here
            if (paused) {
              snapshotTaken();
              await gate;
            }
            await assertLedgerRowsNotLocked(tx, [
              { trackedCategoryId: categoryId, periodBucket: SEPT },
            ]);
            await tx.regulatedSalesLedger.create({ data: sale("2026-09-16T15:00:00Z", SEPT) });
          },
          serializable ? ({ isolationLevel: "Serializable" } as any) : undefined,
        ),
      );
    const first = attempt(true, true);
    first.catch(() => undefined);
    await snapshot;
    await lock(filing.id); // the claim commits while the writer is paused
    release();
    const err: any = await first.then(
      () => null,
      (e) => e,
    );
    // eslint-disable-next-line no-console
    console.log(
      `SA-995 L5 observed: serializable writer error name=${err?.name} code=${err?.code} ` +
        `meta=${JSON.stringify(err?.meta ?? null)} message=${String(err?.message).slice(0, 160)}`,
    );
    expect(err).not.toBeNull();
    expect(`${err?.code} ${err?.message}`).toMatch(/P2034|40001|serializ/i);
    expect(await raw.regulatedSalesLedger.count({ where: { tenantId } })).toBe(0);
    await expect(attempt(true, false)).rejects.toMatchObject({
      response: { code: "LEDGER_PERIOD_LOCKED" },
    });
  }, 120_000);

  // ─── L6 / L7: the tenant's own day ─────────────────────────────────────────────────────────────────────────
  it("L6: a Chicago tenant on its 31st (2026-11-01T03:00Z) cannot lock October or prepare it", async () => {
    const filing = await generatedFiling(2026, 10);
    freezeClock("2026-11-01T03:00:00Z");
    await expect(lock(filing.id)).rejects.toMatchObject({
      status: 409,
      response: { code: "FILING_PERIOD_RUNNING" },
    });
    await expect(prepare(2026, 10)).rejects.toMatchObject({ status: 400 });
    jest.useRealTimers();
    expect((await filingOf(filing.id)).status).toBe("GENERATED");
  }, 120_000);

  it("L7: the same tenant at 2026-11-01T06:00Z (its 1st) locks October", async () => {
    const filing = await generatedFiling(2026, 10);
    freezeClock("2026-11-01T06:00:00Z");
    const out: any = await lock(filing.id);
    jest.useRealTimers();
    expect(out.status).toBe("LOCKED");
  }, 120_000);

  // ─── the daily auto-prepare ────────────────────────────────────────────────────────────────────────────────
  it("cron: 04:00Z on 11-01 logs and skips the Chicago tenant's not-yet-ended October (no FAILED row); the next day prepares it", async () => {
    const cron = new RegulatedFilingCronService(
      prisma,
      tenantCtx,
      filingService() as unknown as RegulatedFilingService,
    );
    freezeClock("2026-11-01T04:00:00Z");
    await cron.autoPrepareClosedFilings();
    jest.useRealTimers();
    const warned = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("Auto-prepare failed") && m.includes(categoryId));
    // eslint-disable-next-line no-console
    console.log(`SA-995 cron observed (2026-11-01T04:00Z): warn=${JSON.stringify(warned)}`);
    expect(warned).toHaveLength(1);
    expect(await raw.regulatedFiling.count({ where: { tenantId, periodKey: "2026-10" } })).toBe(0);
    expect(await raw.regulatedFiling.count({ where: { tenantId, status: "FAILED" } })).toBe(0);

    freezeClock("2026-11-02T04:00:00Z");
    await cron.autoPrepareClosedFilings();
    jest.useRealTimers();
    const next = await raw.regulatedFiling.findFirst({ where: { tenantId, periodKey: "2026-10" } });
    expect(next?.status).toBe("GENERATED");
  }, 120_000);
});
