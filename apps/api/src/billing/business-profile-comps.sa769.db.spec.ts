/**
 * SA-769 (D-S2) - real Postgres. A business profile's module grants are COMP rows written through the SA-693
 * comp path while the confirm holds the add-on advisory locks. The unit specs
 * (platform-admin.controller.business-profile-comps.sa769.spec.ts) run a JS mutex in place of those locks; what
 * only a real database can show is pinned here:
 *
 *   (a) two confirms of the SAME preview in parallel -> one succeeds, one is refused 409 PROFILE_PLAN_CHANGED,
 *       exactly three comp rows, no ledger event, no Stripe call, no override row;
 *   (b) a confirm racing a non-comp add-on enable on the same SKU -> no deadlock, never a second row for the SKU,
 *       no Stripe call from the comp path, and the loser fails cleanly (the result is one consistent state);
 *   (c) real SESSION advisory-lock semantics: a comp enable with `lockHeld` inside the confirm does NOT wait on
 *       the key its own caller holds (< 5 s), while the same enable WITHOUT `lockHeld` does (it self-blocks for
 *       its 10 s wait and 503s). A JS mutex cannot show that: Postgres session locks are per connection and the
 *       confirm's pinned connection is not the enable's.
 *
 * The real AddonService / BusinessProfileService / FeatureOverrideService / BillingEventService / PlatformAdminController
 * confirm route and the REAL `common/db-locks` run over a real Postgres; Stripe is a fake that counts calls, the
 * authority / caches / audit are stubs. Throwaway `qa-*` tenants, removed in afterAll. DB lane (not run in unit CI).
 */
import "reflect-metadata";
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus, UserRole } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";
import { AddonService } from "./addon.service";
import { BillingEventService } from "./billing-event.service";
import { BusinessProfileService } from "./business-profile.service";
import { FeatureOverrideService } from "./feature-override.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import { PlatformAdminController } from "../platform-admin/platform-admin.controller";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const MODULES = ["recurring_routes", "order_delivery", "driver_payments"];
const admin = { sub: "admin-sa769", role: UserRole.SUPER_ADMIN } as any;

describeDb("SA-769 - a profile's comp grants under real advisory locks (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let addons: AddonService;
  let businessProfiles: BusinessProfileService;
  let controller: PlatformAdminController;
  let createdVersionId: string | undefined;
  /** The catalog price of an `order_delivery` SKU, when the (reused or created) catalog has one. */
  let racePrice: string | undefined;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;
  const stripe = {
    isConfigured: true,
    client: {
      subscriptionItems: {
        create: jest.fn(async () => ({ id: `si_sa769_${randomUUID().slice(0, 8)}` })),
        del: jest.fn(async () => ({})),
      },
    },
  };
  const modes: Record<string, string> = {};

  beforeAll(async () => {
    Logger.overrideLogger(false);
    const url = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: url });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    createdVersionId = await ensurePublishedCatalog(
      prisma,
      {
        plans: [{ planKey: "GROWTH", name: "Growth", monthlyPrice: 249 }],
        addons: [{ sku: "order_delivery", name: "Ad hoc order delivery", monthlyPrice: 25 }],
      },
      "business-profile-comps.sa769.db.spec.ts",
    );
    const catalog = new PlanCatalogService(prisma as any);
    const published = await catalog.getPublishedCatalog();
    racePrice = published.addonSkus.some((s: any) => s.sku === "order_delivery")
      ? "price_sa769_race"
      : undefined;

    const events = new BillingEventService(prisma as any);
    const featureOverrides = new FeatureOverrideService(prisma as any);
    addons = new AddonService(
      prisma as any,
      stripe as any,
      { invalidate: jest.fn() } as any, // entitlements (cache only)
      catalog,
      { invalidate: jest.fn() } as any, // featureResolver (cache only)
      { assertFeatureRequiresMet: jest.fn().mockResolvedValue(undefined) } as any, // authority
      events,
      featureOverrides,
    );
    const featureConfig = {
      getState: async (tenantId: string, key: string) => ({
        value: modes[`${tenantId}:${key}`] ?? "unset",
        effective: modes[`${tenantId}:${key}`] ?? "unset",
      }),
      set: async (tenantId: string, key: string, mode: string) => {
        modes[`${tenantId}:${key}`] = mode;
      },
      // BO-04: the confirm drops the cached modes after it writes them; the stub's modes map needs no cache.
      forgetCachedModes: jest.fn(),
    };
    const featurePreview = {
      preview: async () => ({ before: [], after: [], changed: [] }),
    };
    businessProfiles = new BusinessProfileService(
      prisma as any,
      featureOverrides,
      addons,
      featureConfig as any,
      featurePreview as any,
    );
    const stub = () => ({}) as any;
    controller = new PlatformAdminController(
      { recordAdminAction: jest.fn().mockResolvedValue(undefined) } as any, // svc (audit rows are not under test)
      stub(), // platformConfig
      stub(), // billingService
      addons,
      featureOverrides,
      stub(), // entitlementsMode
      stub(), // configSnapshotFlag
      stub(), // featureDiffs
      {
        assertFeatureRequiresMet: jest.fn().mockResolvedValue(undefined),
        invalidate: jest.fn(),
      } as any,
      featurePreview as any,
      stub(), // snapshotAdmin
      businessProfiles,
      featureConfig as any,
    );
  });

  beforeEach(() => {
    stripe.client.subscriptionItems.create.mockClear();
    stripe.client.subscriptionItems.del.mockClear();
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await dropPublishedCatalog(prisma, createdVersionId);
    await prisma?.$disconnect();
    await pool?.end();
  });

  /** A PAYING tenant (ACTIVE, PRODUCTION, a plan, a Stripe subscription id) that holds nothing. */
  async function tenant(label: string): Promise<string> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa769-${run}-${seq}-${label}`,
      "business-profile-comps.sa769.db.spec.ts",
    );
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(t.id);
    await prisma.tenantSubscription.create({
      data: {
        tenantId: t.id,
        planKey: "GROWTH",
        stripeSubId: `sub_sa769_${run}_${seq}`,
        discount: 0,
      } as any,
    });
    return t.id;
  }

  const rows = (tenantId: string) =>
    prisma.tenantAddon.findMany({
      where: { tenantId, addonKey: { in: MODULES } },
      orderBy: { createdAt: "asc" },
    });
  const ledgerCount = (tenantId: string) =>
    prisma.billingEvent.count({
      where: {
        tenantId,
        type: { in: [BILLING_EVENTS.ADDON_ENABLED, BILLING_EVENTS.ADDON_DISABLED] },
      },
    });
  const overrideCount = (tenantId: string) =>
    prisma.tenantFeatureOverride.count({ where: { tenantId } });
  const fingerprintOf = async (tenantId: string) =>
    (await controller.previewBusinessProfile(tenantId, { profile: "delivery_distributor" } as any))
      .planFingerprint;
  const confirm = (tenantId: string, planFingerprint: string) =>
    controller.applyBusinessProfile(
      tenantId,
      { profile: "delivery_distributor", planFingerprint } as any,
      admin,
    );
  const codeOf = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" ? ((r.reason as any)?.getResponse?.()?.code ?? "other") : "ok";

  it("(a) two confirms of the same preview in parallel: one succeeds, one 409 PROFILE_PLAN_CHANGED, exactly 3 comp rows, 0 ledger events, 0 Stripe calls, 0 overrides", async () => {
    const t = await tenant("a");
    const fp = await fingerprintOf(t);

    const res = await Promise.allSettled([confirm(t, fp), confirm(t, fp)]);

    expect(res.map(codeOf).sort()).toEqual(["PROFILE_PLAN_CHANGED", "ok"]);
    const written = await rows(t);
    expect(written.map((r) => r.addonKey).sort()).toEqual([...MODULES].sort());
    for (const r of written) {
      expect(r).toMatchObject({ active: true, isComp: true, stripeItemId: null });
      expect(Number(r.priceSnapshot ?? 0)).toBe(0);
    }
    expect(await ledgerCount(t)).toBe(0);
    expect(await overrideCount(t)).toBe(0);
    expect(stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect(stripe.client.subscriptionItems.del).not.toHaveBeenCalled();
  }, 60_000);

  it("(b) a confirm racing a non-comp enable of the same SKU: no deadlock, one row for the SKU, no Stripe call from the comp path, one consistent outcome", async () => {
    const t = await tenant("b");
    const fp = await fingerprintOf(t);
    const started = Date.now();

    const [confirmRes, enableRes] = await Promise.allSettled([
      confirm(t, fp),
      // a billed enable when the catalog prices the SKU, else the unpriced non-comp enable: both take the SKU's lock
      addons.enableAddon(t, "order_delivery", racePrice),
    ]);

    expect(Date.now() - started).toBeLessThan(30_000); // both settled: nothing deadlocked
    const delivery = (await rows(t)).filter((r) => r.addonKey === "order_delivery");
    expect(delivery).toHaveLength(1); // never a second row for the SKU
    expect(delivery[0].active).toBe(true);
    const all = await rows(t);

    if (confirmRes.status === "fulfilled") {
      // the confirm took the locks first: three comps, and the enable lost with a clean 409
      expect(all.every((r) => r.isComp)).toBe(true);
      expect(all).toHaveLength(3);
      expect(enableRes.status).toBe("rejected");
      expect((enableRes as PromiseRejectedResult).reason?.getStatus?.()).toBe(409);
      expect(stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
      expect(await ledgerCount(t)).toBe(0);
    } else {
      // the enable won the SKU: the confirm re-planned under the lock and was refused BEFORE writing anything
      expect(codeOf(confirmRes)).toBe("PROFILE_PLAN_CHANGED");
      expect(enableRes.status).toBe("fulfilled");
      expect(all.map((r) => r.addonKey)).toEqual(["order_delivery"]);
      expect(delivery[0].isComp).toBe(false); // the paid enable stayed a purchase, never a comp
      const paid = racePrice !== undefined;
      expect(stripe.client.subscriptionItems.create).toHaveBeenCalledTimes(paid ? 1 : 0);
      expect(await ledgerCount(t)).toBe(paid ? 1 : 0);
    }
    expect(await overrideCount(t)).toBe(0);
  }, 60_000);

  it("(c) real session locks: a lockHeld comp enable inside the confirm does not self-block (< 5 s); without lockHeld it waits on its own caller's key and 503s", async () => {
    const t = await tenant("c");

    // the confirm itself: all three comps under the pinned multi-key lock, fast
    const fp = await fingerprintOf(t);
    const t0 = Date.now();
    await confirm(t, fp);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await rows(t)).toHaveLength(3);

    // a fresh tenant: the same enable, called by hand inside the confirm's own lock
    const u = await tenant("c2");
    const held = Date.now();
    await businessProfiles.withConfirmLock(u, () =>
      addons.enableAddon(u, "order_delivery", undefined, undefined, {
        comp: true,
        lockHeld: true,
      }),
    );
    expect(Date.now() - held).toBeLessThan(5_000);
    expect((await rows(u)).map((r) => [r.addonKey, r.isComp])).toEqual([["order_delivery", true]]);

    // the counterfactual: WITHOUT lockHeld the enable asks for the key its caller holds on another connection
    const v = await tenant("c3");
    const blocked = await businessProfiles
      .withConfirmLock(v, () =>
        addons.enableAddon(v, "order_delivery", undefined, undefined, { comp: true }),
      )
      .catch((e) => e);
    expect(blocked).toBeInstanceOf(ServiceUnavailableException);
    expect(await rows(v)).toEqual([]);
  }, 90_000);
});
