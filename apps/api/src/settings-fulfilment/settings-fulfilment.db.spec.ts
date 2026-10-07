/**
 * Settings -> Fulfilment (PR1) against a REAL Postgres: the audited write is one transaction (an audit
 * failure rolls the setting back, and so does a failure on the second field), tenants are isolated,
 * a refused change leaves no row and no audit, an unchanged request writes nothing, and two writers
 * racing from the same screen end as one 200 and one 409 whose body is the winner's state.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host. SAFETY: every tenant is a throwaway
 * `qa-fulfil-<run>-<n>` slug approved by `assertTestTenant`; `afterAll` deletes exactly the tenants THIS
 * run created (rows by tenantId; AuditLog has no FK, so it goes by tenantId too). WRITTEN, NOT RUN by the
 * builder: the coordinator owns the DB lane.
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { AuditService } from "../audit/audit.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { FeatureConfigStore } from "../billing/feature-config.store";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { _resetLockPoolForTests } from "../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SettingsFulfilmentController } from "./settings-fulfilment.controller";
import { SettingsFulfilmentService } from "./settings-fulfilment.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs") as {
  assertTestTenant: (slug: string, context?: string) => string;
};

const RUN = randomUUID().slice(0, 8);
let seq = 0;

describeDb("settings/fulfilment — real Postgres (PR1)", () => {
  const pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
  // An independent reader/cleaner: assertions never go through the service under test.
  const raw = new PrismaClient({ adapter: new PrismaPg(pool) });
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let featureConfig: FeatureConfigService;
  let controller: SettingsFulfilmentController;
  const tenantIds: string[] = [];
  /** Per-tenant fleet (the add-on stand-in): tenantId -> holds Routes. */
  const fleet = new Map<string, boolean>();
  const savedFlag = process.env.FULFILMENT_SELF_SERVE;

  beforeAll(async () => {
    process.env.FULFILMENT_SELF_SERVE = "on";
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const store = new FeatureConfigStore(prisma);
    const addons = {
      getActiveAddons: async (t: string) => (fleet.get(t) ? ["recurring_routes"] : []),
      hasAddon: async (t: string, k: string) => !!fleet.get(t) && k === "recurring_routes",
    };
    const overrides = { get: async () => null, allActive: async () => new Map() };
    const entitlements = { hasFlag: async () => true };
    featureConfig = new FeatureConfigService(
      prisma,
      store,
      new AuditService(prisma),
      addons as never,
      entitlements as never,
      overrides as never,
    );
    controller = new SettingsFulfilmentController(
      new SettingsFulfilmentService(
        prisma,
        featureConfig,
        store,
        addons as never,
        overrides as never,
      ),
    );
  });

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.FULFILMENT_SELF_SERVE;
    else process.env.FULFILMENT_SELF_SERVE = savedFlag;
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup(tenantId).catch((e) => {
        console.warn(`settings-fulfilment.db.spec: cleanup of tenant ${tenantId} failed: ${e}`);
      });
    }
    await _resetLockPoolForTests();
    await prisma?.$disconnect();
    await raw.$disconnect();
    await pool.end();
  });

  async function cleanup(tenantId: string): Promise<void> {
    await raw.auditLog.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { tenantId } });
    await raw.customer.deleteMany({ where: { tenantId } });
    await raw.tenantFeatureConfig.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({ where: { tenantId } });
    await raw.tenant.delete({ where: { id: tenantId } });
  }

  async function seed(opts: { fleet?: boolean } = {}) {
    seq += 1;
    const slug = assertTestTenant(`qa-fulfil-${RUN}-${seq}`, "settings-fulfilment.db.spec.ts");
    const tenant = await raw.tenant.create({ data: { slug, name: `Fulfil ${slug}` } });
    tenantIds.push(tenant.id);
    fleet.set(tenant.id, opts.fleet ?? true);
    const adminUser = await raw.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: `${slug}-admin`,
        role: "TENANT_ADMIN",
        tenantId: tenant.id,
      },
    });
    const admin = {
      sub: adminUser.id,
      username: adminUser.username,
      role: "TENANT_ADMIN",
      tenantId: tenant.id,
      tenantSlug: slug,
    } as unknown as JwtPayload;
    return { tenantId: tenant.id, slug, admin };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;
  const as = <T>(t: Seeded, fn: () => Promise<T>) => tenantCtx.run(t.tenantId, fn);
  const get = (t: Seeded) => as(t, () => controller.get(t.admin));
  const patch = (t: Seeded, body: Record<string, unknown>, user: JwtPayload = t.admin) =>
    as(t, () => controller.update(body, user));
  const rows = (tenantId: string) =>
    raw.tenantFeatureConfig.findMany({ where: { tenantId }, orderBy: { featureKey: "asc" } });
  const audits = (tenantId: string) =>
    raw.auditLog.findMany({ where: { tenantId, action: "FEATURE_CONFIG_SET" } });
  const rejection = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return { status: (e as any).getStatus(), body: (e as any).getResponse() };
    }
    throw new Error("expected a rejection");
  };

  it("a change writes the row and ONE audit with the pinned meta keys and the actor", async () => {
    const t = await seed();
    const g = await get(t);
    const out = await patch(t, { fulfilmentModel: "ship", fingerprint: g.fingerprint });
    expect(out.changed).toBe(true);
    expect(out.fulfilmentModel).toMatchObject({ value: "ship", effective: "ship" });

    const stored = await rows(t.tenantId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      featureKey: "fulfilment_model",
      mode: "ship",
      reason: "Changed in Settings → Fulfillment",
      updatedById: t.admin.sub,
    });
    const logged = await audits(t.tenantId);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      userId: t.admin.sub,
      impersonatedBy: null,
      entityType: "TenantFeatureConfig",
      entityId: "fulfilment_model",
    });
    expect(logged[0].meta).toEqual({
      key: "fulfilment_model",
      from: "unset",
      to: "ship",
      mode: "ship",
      via: "tenant_settings",
      fingerprint: g.fingerprint,
    });
    // Read back through a fresh GET: the cache was dropped after the commit.
    expect((await get(t)).lastChange).toMatchObject({ by: "business", name: t.admin.username });
  });

  it("impersonatedBy is stamped from the token", async () => {
    const t = await seed();
    const g = await get(t);
    const impersonated = { ...t.admin, impersonatedBy: "qa-platform-admin" } as JwtPayload;
    await patch(t, { counterSales: "on", fingerprint: g.fingerprint }, impersonated);
    const logged = await audits(t.tenantId);
    expect(logged).toHaveLength(1);
    expect(logged[0].impersonatedBy).toBe("qa-platform-admin");
  });

  it("an audit failure rolls the setting back (no row, no audit)", async () => {
    const t = await seed();
    const g = await get(t);
    const real = featureConfig.setAuditedInTx.bind(featureConfig);
    // A BigInt in the audit meta cannot be serialised to JSON: the audit insert throws INSIDE the
    // transaction, after the config row was upserted.
    const spy = jest
      .spyOn(featureConfig, "setAuditedInTx")
      .mockImplementationOnce((tx, tenantId, key, mode, actor, meta) =>
        real(tx, tenantId, key, mode, actor, { ...meta, poison: BigInt(1) }),
      );
    try {
      await expect(
        patch(t, { fulfilmentModel: "ship", fingerprint: g.fingerprint }),
      ).rejects.toBeTruthy();
    } finally {
      spy.mockRestore();
    }
    expect(await rows(t.tenantId)).toEqual([]);
    expect(await audits(t.tenantId)).toEqual([]);
    // The lock was released and the next change goes through.
    const again = await patch(t, { fulfilmentModel: "ship", fingerprint: g.fingerprint });
    expect(again.changed).toBe(true);
  });

  it("both fields are ONE transaction: a failure on the second rolls the first back", async () => {
    const t = await seed();
    const g = await get(t);
    const real = featureConfig.setAuditedInTx.bind(featureConfig);
    let calls = 0;
    const spy = jest
      .spyOn(featureConfig, "setAuditedInTx")
      .mockImplementation(async (tx, tenantId, key, mode, actor, meta) => {
        calls += 1;
        if (calls === 2) throw new Error("second write failed");
        return real(tx, tenantId, key, mode, actor, meta);
      });
    try {
      await expect(
        patch(t, { fulfilmentModel: "ship", counterSales: "on", fingerprint: g.fingerprint }),
      ).rejects.toThrow("second write failed");
    } finally {
      spy.mockRestore();
    }
    expect(await rows(t.tenantId)).toEqual([]);
    expect(await audits(t.tenantId)).toEqual([]);

    const ok = await patch(t, {
      fulfilmentModel: "ship",
      counterSales: "on",
      fingerprint: g.fingerprint,
    });
    expect(ok.changed).toBe(true);
    expect((await rows(t.tenantId)).map((r) => [r.featureKey, r.mode])).toEqual([
      ["counter_sales", "on"],
      ["fulfilment_model", "ship"],
    ]);
    expect((await audits(t.tenantId)).map((a) => a.entityId).sort()).toEqual([
      "counter_sales",
      "fulfilment_model",
    ]);
  });

  it("tenant A's change leaves tenant B untouched (rows, audits, GET)", async () => {
    const a = await seed();
    const b = await seed();
    const gb = await get(b);
    await patch(a, { fulfilmentModel: "both", fingerprint: (await get(a)).fingerprint });

    expect(await rows(b.tenantId)).toEqual([]);
    expect(await audits(b.tenantId)).toEqual([]);
    const after = await get(b);
    expect(after.fulfilmentModel.value).toBe("unset");
    expect(after.fingerprint).toBe(gb.fingerprint);
    expect(after.lastChange).toBeNull();
    expect((await rows(a.tenantId)).every((r) => r.tenantId === a.tenantId)).toBe(true);
  });

  it("a refused change leaves no row and no audit: own delivery without a fleet", async () => {
    const t = await seed({ fleet: false });
    const g = await get(t);
    expect(g.fulfilmentModel.options.find((o) => o.key === "delivery")).toMatchObject({
      selectable: false,
      blockedBy: "plan",
    });
    const e = await rejection(
      patch(t, { fulfilmentModel: "delivery", fingerprint: g.fingerprint }),
    );
    expect(e.status).toBe(409);
    expect(e.body.code).toBe(API_ERROR_CODES.FULFILMENT_MODE_NEEDS_FLEET);
    expect(await rows(t.tenantId)).toEqual([]);
    expect(await audits(t.tenantId)).toEqual([]);
  });

  it("a refused change leaves no row and no audit: a carrier order is in transit", async () => {
    const t = await seed();
    const customerUser = await raw.user.create({
      data: {
        email: `cust-${t.slug}@example.invalid`,
        username: `cust-${t.slug}`,
        role: "CUSTOMER",
        tenantId: t.tenantId,
      },
    });
    const customer = await raw.customer.create({
      data: {
        userId: customerUser.id,
        businessName: "Acme Retail",
        contactName: "c",
        tenantId: t.tenantId,
      },
    });
    await patch(t, { fulfilmentModel: "ship", fingerprint: (await get(t)).fingerprint });
    const auditsBefore = (await audits(t.tenantId)).length;
    await raw.order.create({
      data: {
        tenantId: t.tenantId,
        customerId: customer.id,
        orderNumber: `ORD-FULFIL-${RUN}-${seq}`,
        fulfillPath: "SHIP",
        status: "OUT_FOR_DELIVERY",
        shippedAt: new Date(),
      },
    });

    const g = await get(t);
    const e = await rejection(
      patch(t, { fulfilmentModel: "delivery", fingerprint: g.fingerprint }),
    );
    expect(e.status).toBe(409);
    expect(e.body.code).toBe(API_ERROR_CODES.FULFILMENT_CARRIER_IN_TRANSIT);
    expect(e.body.count).toBe(1);
    expect((await rows(t.tenantId)).map((r) => r.mode)).toEqual(["ship"]);
    expect((await audits(t.tenantId)).length).toBe(auditsBefore);

    // Staying inside the shipping set is still allowed.
    const ok = await patch(t, { fulfilmentModel: "both", fingerprint: g.fingerprint });
    expect(ok.changed).toBe(true);
  });

  it("a request equal to what is stored writes nothing (idempotent)", async () => {
    const t = await seed();
    await patch(t, { fulfilmentModel: "ship", fingerprint: (await get(t)).fingerprint });
    const before = await rows(t.tenantId);
    const g = await get(t);
    const again = await patch(t, { fulfilmentModel: "ship", fingerprint: g.fingerprint });
    expect(again.changed).toBe(false);
    const after = await rows(t.tenantId);
    expect(after).toEqual(before);
    expect(after[0].updatedAt.getTime()).toBe(before[0].updatedAt.getTime());
    expect(await audits(t.tenantId)).toHaveLength(1);
    // The symmetric counter case: nothing stored equals "off".
    const off = await patch(t, { counterSales: "off", fingerprint: g.fingerprint });
    expect(off.changed).toBe(false);
    expect(await rows(t.tenantId)).toHaveLength(1);
  });

  it("two writers from the same screen: one 200 and one 409 whose body is the winner's state", async () => {
    const t = await seed();
    const g = await get(t);
    const results = await Promise.allSettled([
      patch(t, { fulfilmentModel: "ship", fingerprint: g.fingerprint }),
      patch(t, { fulfilmentModel: "both", fingerprint: g.fingerprint }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason.getStatus()).toBe(409);
    const body = lost[0].reason.getResponse();
    expect(body.code).toBe(API_ERROR_CODES.FULFILMENT_SETTINGS_STALE);

    const stored = await rows(t.tenantId);
    expect(stored).toHaveLength(1);
    // The 409 body is FRESH: it already shows the winner, and its fingerprint is the live one.
    expect(body.fulfilmentModel.value).toBe(stored[0].mode);
    expect(body.fingerprint).toBe((await get(t)).fingerprint);
    expect(await audits(t.tenantId)).toHaveLength(1);
  });

  it("a Feature Console write between GET and PATCH makes the PATCH stale; lastChange then reads routeflow", async () => {
    const t = await seed();
    const g = await get(t);
    // The console path (set()) takes the same lock and writes the same row.
    await featureConfig.set(t.tenantId, "fulfilment_model", "ship", "console", null);
    const e = await rejection(patch(t, { fulfilmentModel: "both", fingerprint: g.fingerprint }));
    expect(e.status).toBe(409);
    expect(e.body.code).toBe(API_ERROR_CODES.FULFILMENT_SETTINGS_STALE);
    expect(e.body.fulfilmentModel.value).toBe("ship");
    expect(e.body.lastChange).toMatchObject({ by: "routeflow", name: null });
    expect((await rows(t.tenantId)).map((r) => r.mode)).toEqual(["ship"]);
  });
});
