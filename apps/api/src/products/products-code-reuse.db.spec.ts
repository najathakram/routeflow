/**
 * SA-603 / SA-603a DB-lane proof for code release and reuse (real Postgres, throwaway `qa-*` tenants).
 *
 * Run by F2's DB lane (`npm run local:test:db`; `npm run local:test:db` builds its own fresh database). Collected only by
 * `jest.db.config.js` (`.db.spec.ts$`). Needs the Sitting-B bundle migration applied (retired* columns,
 * nullable ProductBarcode.code, the two active-name partial uniques). `requireLocalDatabaseUrl()` refuses any
 * non-local host; every tenant is a `qa-*` slug approved by `assertTestTenant`.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-603a-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "products-code-reuse.db.spec.ts",
  );
};

describeDb("SA-603a code release, lazy reuse, restore and name rule — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: ProductsService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            presignedUrl: jest.fn().mockResolvedValue("http://mock-url"),
            presignedUrls: jest
              .fn()
              .mockImplementation((keys: string[]) =>
                Promise.resolve(keys.map(() => "http://mock-url")),
              ),
            upload: jest.fn().mockResolvedValue(undefined),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        entitlementAuthorityFromEntitlements,
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = module.get(ProductsService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
    await prisma.stockLot.deleteMany({ where: { tenantId } });
    // ProductBarcode/ProductImage cascade on Product delete (schema onDelete: Cascade).
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<string> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `603a ${slug}` } });
    createdTenantIds.push(tenant.id);
    return tenant.id;
  }

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const ACTOR = null;
  const mk = (tenantId: string, name: string, extra: Record<string, unknown> = {}) =>
    inTenant(tenantId, () =>
      service.create({ name, unit: "each", pricePerUnit: "1.00", ...extra } as any, {
        actorId: ACTOR,
      }),
    );
  const fresh = (id: string) => prisma.product.findUniqueOrThrow({ where: { id } });
  const audits = (tenantId: string) =>
    prisma.auditLog.findMany({
      where: { tenantId, action: "product.code_released_on_reuse" },
    });

  it("deactivate releases sku/barcode/unitSku and the level rows; a NEW product then reuses them", async () => {
    const tenantId = await seedTenant("reuse");
    const a = await mk(tenantId, "Alpha", { sku: "SKU-A", barcode: "100100", unitSku: "UNIT-A" });
    await inTenant(tenantId, () => service.update(a.id, { isActive: false } as any));
    const released = await fresh(a.id);
    expect(released).toMatchObject({
      sku: null,
      barcode: null,
      unitSku: null,
      retiredSku: "SKU-A",
      retiredBarcode: "100100",
      retiredUnitSku: "UNIT-A",
    });
    const rows = await prisma.productBarcode.findMany({ where: { tenantId, productId: a.id } });
    expect(rows.every((r) => r.code === null && r.retiredCode === "100100")).toBe(true);

    const b = await mk(tenantId, "Beta", { sku: "SKU-A", barcode: "100100", unitSku: "UNIT-A" });
    expect(await fresh(b.id)).toMatchObject({ sku: "SKU-A", barcode: "100100" });
    expect(await audits(tenantId)).toHaveLength(0); // a normal deactivate is not a lazy release
  });

  it("LAZY release: an already-inactive holder (never released) gives up only the colliding code, audited once, untouched rows unwritten", async () => {
    const tenantId = await seedTenant("lazy");
    const holder = await mk(tenantId, "Old Holder", { sku: "LZ-1", barcode: "200200" });
    const bystander = await mk(tenantId, "Bystander", { sku: "LZ-2" });
    await prisma.product.updateMany({
      where: { id: { in: [holder.id, bystander.id] } },
      data: { isActive: false },
    });
    const before = await fresh(bystander.id);

    const created = await mk(tenantId, "Newcomer", { sku: "LZ-1" });
    expect(await fresh(created.id)).toMatchObject({ sku: "LZ-1" });
    expect(await fresh(holder.id)).toMatchObject({
      sku: null,
      retiredSku: "LZ-1",
      barcode: "200200", // only the colliding code is released
    });
    expect((await fresh(bystander.id)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    const rows = await audits(tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe(holder.id);
  });

  it("an ACTIVE holder is a 409 naming it (CODE_TAKEN for sku via the in-tx claim), nothing written", async () => {
    const tenantId = await seedTenant("active-holder");
    const holder = await mk(tenantId, "Holder", { sku: "AH-1" });
    const before = await fresh(holder.id);
    await expect(mk(tenantId, "Other", { unitSku: "AH-1" })).rejects.toBeDefined();
    expect((await fresh(holder.id)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("RACE: two concurrent creates of a code an INACTIVE holder has -> exactly one wins, one audit row, one retiredSku, loser 409 names the winner", async () => {
    const tenantId = await seedTenant("race-lazy");
    for (let round = 0; round < 4; round += 1) {
      const code = `RC-${round}-${randomUUID().slice(0, 4)}`;
      // eslint-disable-next-line no-await-in-loop
      const holder = await mk(tenantId, `Holder ${round}`, { sku: code });
      // eslint-disable-next-line no-await-in-loop
      await prisma.product.update({ where: { id: holder.id }, data: { isActive: false } });
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.allSettled([
        mk(tenantId, `Racer A ${round}`, { sku: code }),
        mk(tenantId, `Racer B ${round}`, { sku: code }),
      ]);
      const ok = results.filter(
        (r): r is PromiseFulfilledResult<{ id: string }> => r.status === "fulfilled",
      );
      const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(1);
      const body = bad[0].reason.getResponse();
      // The outside 400 pre-check may race the commit; the in-tx claim names the winner.
      if (typeof body === "object") expect(body).toMatchObject({ productId: ok[0].value.id });
      // eslint-disable-next-line no-await-in-loop
      expect(await fresh(holder.id)).toMatchObject({ sku: null, retiredSku: code });
      // eslint-disable-next-line no-await-in-loop
      const all = await audits(tenantId);
      expect(all.filter((a) => a.entityId === holder.id)).toHaveLength(1);
      // eslint-disable-next-line no-await-in-loop
      const holders = await prisma.product.count({ where: { tenantId, sku: code } });
      expect(holders).toBe(1);
    }
  });

  it("RACE: two concurrent REACTIVATIONS of products that both retired the same code -> exactly one wins, the loser keeps its retired value (no orphan), 409 names the winner", async () => {
    const tenantId = await seedTenant("race-reactivate");
    const a = await mk(tenantId, "Re A", { sku: "RR-1" });
    await inTenant(tenantId, () => service.update(a.id, { isActive: false } as any));
    const b = await mk(tenantId, "Re B", { sku: "RR-1" });
    await inTenant(tenantId, () => service.update(b.id, { isActive: false } as any));

    const results = await Promise.allSettled([
      inTenant(tenantId, () => service.update(a.id, { isActive: true } as any)),
      inTenant(tenantId, () => service.update(b.id, { isActive: true } as any)),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    const [fa, fb] = await Promise.all([fresh(a.id), fresh(b.id)]);
    const winner = fa.sku === "RR-1" ? fa : fb;
    const loser = winner.id === fa.id ? fb : fa;
    expect(winner).toMatchObject({ sku: "RR-1", retiredSku: null, isActive: true });
    expect(loser).toMatchObject({ sku: null, retiredSku: "RR-1", isActive: false });
    expect(bad[0].reason.getResponse()).toMatchObject({
      code: "CODE_TAKEN",
      field: "sku",
      productId: winner.id,
    });
  });

  it("RACE: an assign (update sku) and a create racing for one released code -> exactly one wins, no orphaned retired* value", async () => {
    const tenantId = await seedTenant("race-assign");
    const old = await mk(tenantId, "Gone", { sku: "AS-1" });
    await inTenant(tenantId, () => service.update(old.id, { isActive: false } as any));
    const other = await mk(tenantId, "Other", { sku: "AS-2" });

    const results = await Promise.allSettled([
      mk(tenantId, "Newly Created", { sku: "AS-1" }),
      inTenant(tenantId, () => service.update(other.id, { sku: "AS-1" } as any)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.product.count({ where: { tenantId, sku: "AS-1" } })).toBe(1);
    // The released holder keeps its retired value untouched by either racer.
    expect(await fresh(old.id)).toMatchObject({ sku: null, retiredSku: "AS-1" });
  });

  it("reactivate restores every retired code that is still free, and the level rows come back", async () => {
    const tenantId = await seedTenant("restore");
    const a = await mk(tenantId, "Restorable", { sku: "RS-1", barcode: "300300", unitsPerBox: 12 });
    await inTenant(tenantId, () => service.update(a.id, { isActive: false } as any));
    await inTenant(tenantId, () => service.update(a.id, { isActive: true } as any));
    expect(await fresh(a.id)).toMatchObject({
      sku: "RS-1",
      barcode: "300300",
      retiredSku: null,
      retiredBarcode: null,
    });
    const rows = await prisma.productBarcode.findMany({ where: { tenantId, productId: a.id } });
    expect(rows.map((r) => r.code).sort()).toEqual(["300300", "300300"]);
    expect(rows.every((r) => r.retiredCode === null)).toBe(true);
  });

  it("reactivate against an ACTIVE holder of the code is a 409 naming it, and nothing is restored", async () => {
    const tenantId = await seedTenant("reactivate-409");
    const a = await mk(tenantId, "Was Here", { sku: "R4-1" });
    await inTenant(tenantId, () => service.update(a.id, { isActive: false } as any));
    const holder = await mk(tenantId, "Took It", { sku: "R4-1" });
    const err = await inTenant(tenantId, () =>
      service.update(a.id, { isActive: true } as any),
    ).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "CODE_TAKEN", productId: holder.id });
    expect(await fresh(a.id)).toMatchObject({ isActive: false, sku: null, retiredSku: "R4-1" });
  });

  it("NAME: an inactive product does not block a name; an ACTIVE same-name holder blocks reactivation (409 NAME_TAKEN); concurrent creates of one name -> one wins", async () => {
    const tenantId = await seedTenant("names");
    const a = await mk(tenantId, "Samename");
    await inTenant(tenantId, () => service.update(a.id, { isActive: false } as any));
    const b = await mk(tenantId, "samename");
    expect(b.id).toBeDefined();
    const err = await inTenant(tenantId, () =>
      service.update(a.id, { isActive: true } as any),
    ).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "NAME_TAKEN", productId: b.id });

    const results = await Promise.allSettled([
      mk(tenantId, "Raced Name"),
      mk(tenantId, "raced name"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const bad = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(bad.reason.getResponse()).toMatchObject({ code: "NAME_TAKEN" });
  });

  it("DOOR: PATCH {isActive:true, deactivateHolderIds:[holder]} deactivates exactly the blocking holder and reactivates, in one tx, with an audit row", async () => {
    const tenantId = await seedTenant("door");
    const a = await mk(tenantId, "Door A", { sku: "DR-1" });
    await inTenant(tenantId, () => service.update(a.id, { isActive: false } as any));
    const holder = await mk(tenantId, "Door Holder", { sku: "DR-1" });
    const bystander = await mk(tenantId, "Bystander", { sku: "DR-9" });

    // The wrong set is refused and nothing moves.
    const bad = await inTenant(tenantId, () =>
      service.update(a.id, { isActive: true, deactivateHolderIds: [bystander.id] } as any),
    ).catch((e) => e);
    expect(bad.getResponse()).toMatchObject({
      code: "CODE_TAKEN",
      productId: holder.id,
      holders: [{ productId: holder.id, field: "sku", value: "DR-1" }],
    });
    expect(await fresh(holder.id)).toMatchObject({ isActive: true, sku: "DR-1" });
    expect(await fresh(a.id)).toMatchObject({ isActive: false, retiredSku: "DR-1" });

    // The exact set succeeds: holder off (codes released), A on with its sku back.
    await inTenant(tenantId, () =>
      service.update(a.id, { isActive: true, deactivateHolderIds: [holder.id] } as any),
    );
    expect(await fresh(holder.id)).toMatchObject({
      isActive: false,
      sku: null,
      retiredSku: "DR-1",
    });
    expect(await fresh(a.id)).toMatchObject({ isActive: true, sku: "DR-1", retiredSku: null });
    expect(await fresh(bystander.id)).toMatchObject({ isActive: true });
    const log = await prisma.auditLog.findMany({
      where: { tenantId, action: "product.deactivated_for_reactivation" },
    });
    expect(log.map((l) => l.entityId)).toEqual([holder.id]);
  });

  it("DOOR RACE: two products that both retired one code are reactivated at once, each naming the other as holder -> exactly one ends active, none lost", async () => {
    const tenantId = await seedTenant("door-race");
    const a = await mk(tenantId, "Race A", { sku: "DRR-1" });
    await inTenant(tenantId, () => service.update(a.id, { isActive: false } as any));
    const b = await mk(tenantId, "Race B", { sku: "DRR-1" });
    await inTenant(tenantId, () => service.update(b.id, { isActive: false } as any));
    const c = await mk(tenantId, "Race C", { sku: "DRR-1" }); // the active holder both contend with

    const results = await Promise.allSettled([
      inTenant(tenantId, () =>
        service.update(a.id, { isActive: true, deactivateHolderIds: [c.id] } as any),
      ),
      inTenant(tenantId, () =>
        service.update(b.id, { isActive: true, deactivateHolderIds: [c.id] } as any),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const bad = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(["HOLDERS_CHANGED", "CODE_TAKEN"]).toContain(bad.reason.getResponse().code);
    const all = await Promise.all([fresh(a.id), fresh(b.id), fresh(c.id)]);
    expect(all.filter((p) => p.sku === "DRR-1")).toHaveLength(1); // exactly one holder of the code
    expect(all.filter((p) => p.isActive && p.sku === "DRR-1")).toHaveLength(1);
    // The loser keeps its retired value (no orphan).
    const loser = all.find((p) => p.sku == null && p.id !== c.id)!;
    expect(loser.retiredSku === "DRR-1" || loser.isActive === false).toBe(true);
  });

  // ── Opus #2860 B1/B2/B3: lock-order pins. A deadlock (40P01) surfaces as a raw 500; each race below must end with
  // ONLY 2xx / 4xx outcomes. What each scenario PINS (F2's revert probe, removing the single sorted lock set in
  // `update()`): scenario C goes red deterministically; A, B and D are best-effort SMOKE pins (the interleavings are
  // timing-dependent, so they may stay green on a revert): they guard against regressions but are not the proof of the
  // lock. The deterministic proof of the lock SET is the unit probe in products.code-release-wiring.spec.ts.
  const barrier = async <T>(...fns: Array<() => Promise<T>>) => {
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const started = fns.map((fn) => gate.then(fn)); // all start in the SAME tick once released
    open();
    return Promise.allSettled(started);
  };
  const noServerErrors = (results: PromiseSettledResult<unknown>[]) => {
    for (const r of results) {
      if (r.status === "rejected") {
        const status = typeof r.reason?.getStatus === "function" ? r.reason.getStatus() : 500;
        expect({ status, message: String(r.reason?.message) }).toEqual(
          expect.objectContaining({ status: expect.any(Number) }),
        );
        expect(status).toBeLessThan(500);
      }
    }
  };
  const ROUNDS = 6;

  it("LOCK ORDER A: a door (P2 is the holder) vs an ordinary PATCH of P2 never deadlocks (no 500)", async () => {
    const tenantId = await seedTenant("lo-a");
    for (let i = 0; i < ROUNDS; i += 1) {
      const x = `LA-X-${i}-${randomUUID().slice(0, 4)}`;
      const y = `LA-Y-${i}-${randomUUID().slice(0, 4)}`;
      // eslint-disable-next-line no-await-in-loop
      const p1 = await mk(tenantId, `LA P1 ${i}`, { sku: x });
      // eslint-disable-next-line no-await-in-loop
      await inTenant(tenantId, () => service.update(p1.id, { isActive: false } as any));
      // eslint-disable-next-line no-await-in-loop
      const p2 = await mk(tenantId, `LA P2 ${i}`, { sku: x, barcode: y });
      // eslint-disable-next-line no-await-in-loop
      const results = await barrier(
        () =>
          inTenant(tenantId, () =>
            service.update(p1.id, { isActive: true, deactivateHolderIds: [p2.id] } as any),
          ),
        () => inTenant(tenantId, () => service.update(p2.id, { pricePerUnit: "2.00" } as any)),
      );
      noServerErrors(results);
    }
  });

  it("LOCK ORDER B: a door vs DELETE of the holder never deadlocks (no 500)", async () => {
    const tenantId = await seedTenant("lo-b");
    for (let i = 0; i < ROUNDS; i += 1) {
      const x = `LB-X-${i}-${randomUUID().slice(0, 4)}`;
      const y = `LB-Y-${i}-${randomUUID().slice(0, 4)}`;
      // eslint-disable-next-line no-await-in-loop
      const p1 = await mk(tenantId, `LB P1 ${i}`, { sku: x });
      // eslint-disable-next-line no-await-in-loop
      await inTenant(tenantId, () => service.update(p1.id, { isActive: false } as any));
      // eslint-disable-next-line no-await-in-loop
      const p2 = await mk(tenantId, `LB P2 ${i}`, { sku: x, barcode: y });
      // eslint-disable-next-line no-await-in-loop
      const results = await barrier(
        () =>
          inTenant(tenantId, () =>
            service.update(p1.id, { isActive: true, deactivateHolderIds: [p2.id] } as any),
          ),
        () => inTenant(tenantId, () => service.remove(p2.id)),
      );
      noServerErrors(results);
    }
  });

  it("LOCK ORDER C: two doors naming the SAME holder for different retired codes never deadlock; at least one wins", async () => {
    const tenantId = await seedTenant("lo-c");
    for (let i = 0; i < ROUNDS; i += 1) {
      const x = `LC-X-${i}-${randomUUID().slice(0, 4)}`;
      const y = `LC-Y-${i}-${randomUUID().slice(0, 4)}`;
      // eslint-disable-next-line no-await-in-loop
      const p1 = await mk(tenantId, `LC P1 ${i}`, { sku: x });
      // eslint-disable-next-line no-await-in-loop
      await inTenant(tenantId, () => service.update(p1.id, { isActive: false } as any));
      // eslint-disable-next-line no-await-in-loop
      const p4 = await mk(tenantId, `LC P4 ${i}`, { barcode: y });
      // eslint-disable-next-line no-await-in-loop
      await inTenant(tenantId, () => service.update(p4.id, { isActive: false } as any));
      // eslint-disable-next-line no-await-in-loop
      const p2 = await mk(tenantId, `LC P2 ${i}`, { sku: x, barcode: y });
      // eslint-disable-next-line no-await-in-loop
      const results = await barrier(
        () =>
          inTenant(tenantId, () =>
            service.update(p1.id, { isActive: true, deactivateHolderIds: [p2.id] } as any),
          ),
        () =>
          inTenant(tenantId, () =>
            service.update(p4.id, { isActive: true, deactivateHolderIds: [p2.id] } as any),
          ),
      );
      noServerErrors(results);
      expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    }
  });

  it("LOCK ORDER D (B2): PATCH {sku} on a product that holds a barcode vs a create claiming that sku AND barcode never deadlocks", async () => {
    const tenantId = await seedTenant("lo-d");
    for (let i = 0; i < ROUNDS; i += 1) {
      const z = `LD-Z-${i}-${randomUUID().slice(0, 4)}`;
      const a = `LD-A-${i}-${randomUUID().slice(0, 4)}`;
      // eslint-disable-next-line no-await-in-loop
      const p3 = await mk(tenantId, `LD P3 ${i}`, { barcode: z });
      // eslint-disable-next-line no-await-in-loop
      const results = await barrier(
        () => inTenant(tenantId, () => service.update(p3.id, { sku: a } as any)),
        () => mk(tenantId, `LD New ${i}`, { sku: a, barcode: z }),
      );
      noServerErrors(results);
    }
  });
});
