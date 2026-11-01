/**
 * W1: the first question against a REAL Postgres. The answer writes the setup and closes the marker, a second answer is a
 * 409, an account whose setup already changed is kept as it is (the marker closes, nothing else moves), an account with no
 * marker (every live tenant) cannot be asked, one account cannot answer for another, and the marker is only ever moved from
 * `pending`.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db` (its own `rf_dbspec_*` database).
 * SAFETY: every tenant is a throwaway `qa-firstrun-<run>-<n>` slug approved by `assertTestTenant`; `afterAll` deletes exactly
 * the tenants THIS run created.
 */
import "reflect-metadata";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Logger } from "@nestjs/common";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { AuditService } from "../audit/audit.service";
import { AddonService } from "../billing/addon.service";
import { BillingEventService } from "../billing/billing-event.service";
import { BusinessProfileApplyService } from "../billing/business-profile-apply.service";
import { BusinessProfileService } from "../billing/business-profile.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { FeatureConfigStore } from "../billing/feature-config.store";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { FIRST_RUN_KEY, closeFirstRun, createPendingFirstRun } from "../billing/first-run-marker";
import { BILLING_EVENTS } from "../billing/plan-catalog.constants";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { _resetLockPoolForTests } from "../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { FirstRunService } from "./first-run.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs") as {
  assertTestTenant: (slug: string, context?: string) => string;
};

const RUN = randomUUID().slice(0, 8);
let seq = 0;

describeDb("first question - real Postgres (W1)", () => {
  const pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
  const raw = new PrismaClient({ adapter: new PrismaPg(pool) });
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: FirstRunService;
  const ownerAlerts = { keptSetup: jest.fn(async () => undefined) };
  const tenantIds: string[] = [];

  beforeAll(async () => {
    Logger.overrideLogger(false);
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const stripe = { isConfigured: false, client: {} };
    const catalog = new PlanCatalogService(prisma as never);
    const overrides = new FeatureOverrideService(prisma as never);
    const authority = {
      assertFeatureRequiresMet: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn(),
    };
    const addons = new AddonService(
      prisma as never,
      stripe as never,
      { invalidate: jest.fn() } as never,
      catalog,
      { invalidate: jest.fn() } as never,
      authority as never,
      new BillingEventService(prisma as never),
      overrides,
    );
    const audit = new AuditService(prisma);
    const featureConfig = new FeatureConfigService(
      prisma,
      new FeatureConfigStore(prisma),
      audit,
      addons,
      { hasFlag: async () => true } as never,
      overrides,
    );
    const featurePreview = { preview: async () => ({ before: [], after: [], changed: [] }) };
    const businessProfiles = new BusinessProfileService(
      prisma as never,
      overrides,
      addons,
      featureConfig,
      featurePreview as never,
    );
    const apply = new BusinessProfileApplyService(
      addons,
      authority as never,
      featureConfig,
      featurePreview as never,
      businessProfiles,
      prisma,
    );
    service = new FirstRunService(
      prisma,
      featureConfig,
      businessProfiles,
      apply,
      audit,
      ownerAlerts as never,
    );
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup(tenantId).catch((e) => {
        console.warn(`first-run.db.spec: cleanup of tenant ${tenantId} failed: ${e}`);
      });
    }
    await _resetLockPoolForTests();
    await prisma?.$disconnect();
    await raw.$disconnect();
    await pool.end();
  });

  async function cleanup(tenantId: string): Promise<void> {
    await raw.auditLog.deleteMany({ where: { tenantId } });
    await raw.billingEvent.deleteMany({ where: { tenantId } });
    await raw.tenantAddon.deleteMany({ where: { tenantId } });
    await raw.tenantFeatureOverride.deleteMany({ where: { tenantId } });
    await raw.tenantFeatureConfig.deleteMany({ where: { tenantId } });
    await raw.systemConfig.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({ where: { tenantId } });
    await raw.tenant.delete({ where: { id: tenantId } });
  }

  async function seed(opts: { marker?: boolean; mode?: string } = {}) {
    seq += 1;
    const slug = assertTestTenant(`qa-firstrun-${RUN}-${seq}`, "first-run.db.spec.ts");
    const tenant = await raw.tenant.create({
      data: {
        slug,
        name: `First run ${slug}`,
        class: TenantClass.PRODUCTION,
        status: TenantStatus.TRIAL,
      },
    });
    tenantIds.push(tenant.id);
    if (opts.marker ?? true) await createPendingFirstRun(raw, tenant.id);
    if (opts.mode) {
      await raw.tenantFeatureConfig.create({
        data: {
          tenantId: tenant.id,
          featureKey: "fulfilment_model",
          mode: opts.mode,
          reason: "seed",
        },
      });
    }
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
  const answer = (t: Seeded, body: unknown, user: JwtPayload = t.admin) =>
    as(t, () => service.answer(body, user));
  const status = (t: Seeded) => as(t, () => service.status(t.admin));
  const marker = async (tenantId: string) =>
    (await raw.systemConfig.findFirst({ where: { tenantId, key: FIRST_RUN_KEY } }))?.value ?? null;
  const modes = async (tenantId: string) =>
    Object.fromEntries(
      (await raw.tenantFeatureConfig.findMany({ where: { tenantId } })).map((r) => [
        r.featureKey,
        r.mode,
      ]),
    );
  const auditActions = async (tenantId: string) =>
    (await raw.auditLog.findMany({ where: { tenantId } })).map((a) => a.action);
  const rejection = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return { status: (e as any).getStatus(), body: (e as any).getResponse() };
    }
    throw new Error("expected a rejection");
  };

  beforeEach(() => ownerAlerts.keptSetup.mockClear());

  it("a new account answers once: the setup is written, the marker reads answered, the card reads back what was ticked", async () => {
    const t = await seed();
    expect(await status(t)).toMatchObject({ state: "pending", workspaceId: t.slug });

    expect(await answer(t, { shipping: true })).toEqual({ outcome: "applied", state: "answered" });

    expect(await marker(t.tenantId)).toBe("answered");
    expect((await modes(t.tenantId)).fulfilment_model).toBe("ship");
    expect(await auditActions(t.tenantId)).toContain("BUSINESS_PROFILE_APPLIED");
    expect(await status(t)).toMatchObject({
      state: "answered",
      workspaceId: t.slug,
      shipping: true,
      delivery: false,
      hasOrder: false,
    });
    expect(ownerAlerts.keptSetup).not.toHaveBeenCalled();
  });

  it("F18: a Delivery answer runs the comps under the held lock, logged as signup.setup by the TENANT_USER who clicked", async () => {
    const t = await seed();
    expect(await answer(t, { delivery: true })).toEqual({ outcome: "applied", state: "answered" });
    const events = await raw.billingEvent.findMany({
      where: { tenantId: t.tenantId, type: BILLING_EVENTS.ADDON_STATE_CHANGED },
    });
    // Delivery comps at least one add-on: every such event names the tenant path, never the back office.
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.payload).toMatchObject({
        source: "signup.setup",
        actor: { kind: "TENANT_USER", id: t.admin.sub },
      });
      expect(e.actorId).toBe(t.admin.sub);
    }
    expect(await auditActions(t.tenantId)).toEqual(
      expect.arrayContaining(["ADDON_COMPED", "BUSINESS_PROFILE_APPLIED"]),
    );
  });

  it("F11: a second answer is a 409 FIRST_RUN_CLOSED and moves nothing", async () => {
    const t = await seed();
    await answer(t, { shipping: true });
    const before = await modes(t.tenantId);
    const r = await rejection(answer(t, { delivery: true }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: API_ERROR_CODES.FIRST_RUN_CLOSED });
    expect(await modes(t.tenantId)).toEqual(before);
    expect(await marker(t.tenantId)).toBe("answered");
  });

  it("F14: an account with no marker (every live tenant) has no card and cannot be asked", async () => {
    const t = await seed({ marker: false });
    expect((await status(t)).state).toBeNull();
    const r = await rejection(answer(t, { shipping: true }));
    expect(r.status).toBe(409);
    expect(await marker(t.tenantId)).toBeNull();
    expect(await modes(t.tenantId)).toEqual({});
  });

  it("F16: a setup that already changed is kept: the marker closes, the mode stays, the owner is told", async () => {
    const t = await seed({ mode: "delivery" });
    expect(await answer(t, { shipping: true })).toEqual({ outcome: "kept", state: "closed" });
    expect(await marker(t.tenantId)).toBe("closed");
    expect((await modes(t.tenantId)).fulfilment_model).toBe("delivery");
    const actions = await auditActions(t.tenantId);
    expect(actions).toContain("FIRST_RUN_KEPT");
    expect(actions).not.toContain("BUSINESS_PROFILE_APPLIED");
    expect(ownerAlerts.keptSetup).toHaveBeenCalledWith(t.tenantId);
  });

  it("F10: nothing ticked is a 400 and leaves the question open", async () => {
    const t = await seed();
    const r = await rejection(answer(t, {}));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: API_ERROR_CODES.FIRST_RUN_EMPTY });
    expect(await marker(t.tenantId)).toBe("pending");
  });

  it("one account cannot answer for another: the other's question stays open", async () => {
    const a = await seed();
    const b = await seed();
    const r = await rejection(as(a, () => service.answer({ shipping: true }, b.admin)));
    expect(r.status).toBe(403);
    expect(await marker(b.tenantId)).toBe("pending");
    expect(await marker(a.tenantId)).toBe("pending");
    expect(await modes(b.tenantId)).toEqual({});
  });

  it("two answers racing from two tabs end as one applied and one 409", async () => {
    const t = await seed();
    const results = await Promise.allSettled([
      answer(t, { shipping: true }),
      answer(t, { shipping: true }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.getStatus()).toBe(409);
    expect(await marker(t.tenantId)).toBe("answered");
  });

  it("the close helper moves only a pending marker and never creates a row", async () => {
    const withMarker = await seed();
    const without = await seed({ marker: false });
    expect(await closeFirstRun(raw, without.tenantId, "closed")).toBe(false);
    expect(await marker(without.tenantId)).toBeNull();
    expect(await closeFirstRun(raw, withMarker.tenantId, "closed")).toBe(true);
    expect(await closeFirstRun(raw, withMarker.tenantId, "answered")).toBe(false);
    expect(await marker(withMarker.tenantId)).toBe("closed");
  });
});
