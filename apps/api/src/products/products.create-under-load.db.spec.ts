/**
 * Row 232 (UX Pass 2 P1): product create under load. DB-lane repro on the REAL create path, real Postgres, throwaway
 * `qa-*` tenants; collected only by `jest.db.config.js` (`npm run local:test:db`).
 *
 * The create transaction takes the barcode advisory lock (`lockBarcodeCodes`) inside `tenantTransaction`. A second
 * connection holds that lock longer than the transaction's budget, the way a concurrent create, import or barcode edit
 * of the same code does under load. The create must end as a CODED lock refusal the global LockConflictFilter answers
 * as a retryable 503 (SQLSTATE 55P03, the house SA-767 shape), never as Prisma's tx-budget expiry, and the retry the
 * client then sends must create exactly one product with its barcode row (never a TypeError).
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ProductsService } from "./products.service";
import { ProductFamiliesService } from "./product-families.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { AuditService } from "../audit/audit.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { stockTxRetryState } from "../common/tx-retry";
import { LockConflictFilter, LOCK_UNAVAILABLE_BODY } from "../common/lock-conflict.filter";
import { barcodeEquivalents } from "./product-catalog-sync";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const FILE = "products.create-under-load.db.spec.ts";
const RUN = randomUUID().slice(0, 8);
let seq = 0;
const HOLD_MS = 8_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeDb("row 232: product create under a held barcode lock - real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let products: ProductsService;
  const tenantIds: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    process.on("unhandledRejection", onUnhandled);
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        ProductFamiliesService,
        AuditService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            presignedUrl: jest.fn().mockResolvedValue("http://mock-url"),
            presignedUrls: jest.fn().mockResolvedValue([]),
            upload: jest.fn().mockResolvedValue(undefined),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    products = module.get(ProductsService);
  });

  afterAll(async () => {
    process.off("unhandledRejection", onUnhandled);
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await prisma.auditLog.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch(() => {
        // Best-effort cleanup must never mask a test's own result.
      });
    }
    await prisma?.$disconnect();
  });

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  async function freshTenant(label: string): Promise<string> {
    seq += 1;
    const slug = assertTestTenant(`qa-r232-${RUN}-${seq}-${label}`, FILE);
    const tenant = await prisma.tenant.create({ data: { slug, name: `r232 ${slug}` } });
    tenantIds.push(tenant.id);
    return tenant.id;
  }

  /**
   * Another connection holds the barcode advisory lock for `ms`. Resolves once it is HELD, with `{ done }` (the holder's
   * transaction). Wrapped in an object: an async function returning the promise itself would make the caller await it.
   */
  async function holdBarcodeLock(tenantId: string, code: string, ms: number) {
    let held!: () => void;
    const acquired = new Promise<void>((r) => (held = r));
    const done = prisma.$transaction(
      async (tx: any) => {
        // The same keys lockBarcodeCodes takes: every equivalent form of the code, in sorted order.
        for (const key of [...new Set(barcodeEquivalents(code))].sort()) {
          // eslint-disable-next-line no-await-in-loop
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"product-barcode"}), hashtext(${`${tenantId}:${key}`}))`;
        }
        held();
        await sleep(ms);
      },
      { timeout: ms + 10_000 },
    );
    await acquired;
    return { done };
  }

  const body = (code: string) =>
    ({ name: `Load Widget ${code}`, unit: "each", pricePerUnit: "4.00", barcode: code }) as any;

  it("REG-232-A: a create stuck behind a held barcode lock is a coded lock timeout (55P03), not the tx expiry (P2028); nothing written", async () => {
    const tenantId = await freshTenant("a");
    const code = `0${Date.now()}`.slice(-12);
    const { done: holder } = await holdBarcodeLock(tenantId, code, HOLD_MS);
    const t0 = Date.now();
    const err = await inTenant(tenantId, () => products.create(body(code))).then(
      () => null,
      (e) => e,
    );
    const elapsed = Date.now() - t0;
    await holder;
    await sleep(500);
    // Observed values first, so a red run reports what master actually does.
    const observed = {
      state: err ? stockTxRetryState(err) : "no error",
      code: err?.code ?? null,
      name: err?.name ?? null,
      message: String(err?.message ?? "").slice(0, 160),
      elapsed,
      unhandled: unhandled.map((u) => String((u as Error)?.message ?? u).slice(0, 160)),
    };
    // Master (observed): state P2028 "A query cannot be executed on an expired transaction" after ~8.1 s - the request
    // and its pooled connection wait out the WHOLE hold, because the 5 s tx budget cannot interrupt a lock wait.
    // SA-855: bounded by lock_timeout 5 s -> 55P03, nothing written, a single attempt (no retry).
    expect(observed).toMatchObject({ state: "55P03", unhandled: [] });
    expect(observed.elapsed).toBeLessThan(6_500);
    expect(await prisma.product.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.productBarcode.count({ where: { tenantId } })).toBe(0);

    // The wire: this exact error, through the global filter, is the coded retryable 503 (SA-767), never a 500.
    const res = {
      status: jest.fn().mockReturnThis(),
      header: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = { catch: jest.fn() };
    const host: any = {
      getType: () => "http",
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({
          method: "POST",
          originalUrl: "/api/v1/products",
          url: "/api/v1/products",
        }),
      }),
    };
    new LockConflictFilter(next).catch(err, host);
    expect(next.catch).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.header).toHaveBeenCalledWith("Retry-After", "2");
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining(LOCK_UNAVAILABLE_BODY));
  }, 30_000);

  // Pin, green on master: the reported "retry TypeError null id" does not reproduce on the service path.
  it("REG-232-B: the client's retry after that refusal creates exactly one product with its barcode row", async () => {
    const tenantId = await freshTenant("b");
    const code = `1${Date.now()}`.slice(-12);
    const { done: holder } = await holdBarcodeLock(tenantId, code, HOLD_MS);
    await inTenant(tenantId, () => products.create(body(code))).catch(() => undefined);
    await holder;
    const retried = await inTenant(tenantId, () => products.create(body(code))).then(
      (p) => ({ ok: true, id: p?.id ?? null }),
      (e) => ({ ok: false, error: `${e?.name}: ${String(e?.message).slice(0, 160)}` }),
    );
    expect(retried).toMatchObject({ ok: true });
    const rows = await prisma.product.findMany({ where: { tenantId }, select: { id: true } });
    expect(rows).toHaveLength(1);
    expect(await prisma.productBarcode.count({ where: { tenantId, code } })).toBe(1);
  }, 30_000);

  it("REG-232-D: with no holder, create still succeeds with its barcode row", async () => {
    const tenantId = await freshTenant("d");
    const code = `2${Date.now()}`.slice(-12);
    const p = await inTenant(tenantId, () => products.create(body(code)));
    expect(p.id).toBeTruthy();
    expect(await prisma.productBarcode.count({ where: { tenantId, code } })).toBe(1);
  });
});
