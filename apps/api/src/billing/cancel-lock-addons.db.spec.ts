/**
 * SA-787 - the cancellation lock changes a tenant's STATUS, never its entitlements. Real Postgres.
 *
 * `applyScheduledCancellations` used to switch EVERY active add-on off (comps and admin-only SKUs included) with no
 * per-row record, so a reactivated tenant came back without the add-ons it held, and a cancelled-but-read-only
 * tenant lost the regulated gate its record-keeping depends on (SA-776). The lock now leaves `active`, the price,
 * `isComp` and the quantity alone; it only clears the Stripe item pointers the cancelled subscription took with it.
 *
 * Fixture (the matrix in decisions/sa/SA-787.md): a PRODUCTION, ACTIVE, paying manual-pay tenant with an armed,
 * past-due cancellation, holding
 *   (a) a self-serve priced row with a Stripe item          FORECASTING        25  si_a
 *   (b) an admin-only priced regulated row (legacy key)     tobacco_dealer     39
 *   (c) a comp row                                          MSRP                0  isComp
 *   (d) a $0 row included at its plan                       OCR_PACK_250        0
 *   (e) a self-serve row the tenant DISABLED before         CUSTOMER_PACK_100  12  active=false
 *
 * Master's values are recorded in the PR body (M1: a-d active=false). Tenants are throwaway `qa-sa787-*` slugs
 * (assertTestTenant). The advisory cron lock is a pass-through (the tick is invoked directly); the sweeps scan the
 * whole scratch database, so every assertion is scoped to this run's tenant ids.
 */
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  withAdvisoryLocks: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BillingCronService } from "./billing-cron.service";
import { BillingEventService } from "./billing-event.service";
import { AutoLockSwitchService } from "./auto-lock-switch.service";
import { AUTO_LOCKS_PAUSED_KEY } from "./auto-lock-gate";
import { AddonService } from "./addon.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { ProrationService } from "./proration.service";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";
import { MrrService } from "./mrr.service";
import { PlatformAdminService } from "../platform-admin/platform-admin.service";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "cancel-lock-addons.db.spec.ts";
const DAY = 24 * 60 * 60 * 1000;

describeDb("SA-787 the cancellation lock never switches add-ons off (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let cron: BillingCronService;
  let admin: PlatformAdminService;
  let mutations: SubscriptionMutationService;
  let sw: AutoLockSwitchService;
  let catalog: PlanCatalogService;
  let events: BillingEventService;
  let createdVersionId: string | undefined;
  let originalSwitch: { value: string } | null = null;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;
  const price: Record<string, number> = {};
  const noop: any = { invalidate: jest.fn() };
  const stripeStub: any = { isConfigured: false };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    originalSwitch = await prisma.platformConfig.findUnique({
      where: { key: AUTO_LOCKS_PAUSED_KEY },
      select: { value: true },
    });
    createdVersionId = await ensurePublishedCatalog(
      prisma,
      {
        plans: [
          { planKey: "STARTER", name: "Starter", monthlyPrice: 99 },
          { planKey: "GROWTH", name: "Growth", monthlyPrice: 249 },
          { planKey: "SCALE", name: "Scale", monthlyPrice: 499 },
        ],
        addons: [
          { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 25 },
          { sku: "REGULATED_ITEMS", name: "Regulated items", monthlyPrice: 39 },
          { sku: "MSRP", name: "MSRP", monthlyPrice: 20 },
          { sku: "OCR_PACK_250", name: "OCR pack", monthlyPrice: 30 },
          { sku: "CUSTOMER_PACK_100", name: "Customer pack", monthlyPrice: 12 },
        ],
      },
      SPEC,
    );
    catalog = new PlanCatalogService(prisma as any);
    const published = await catalog.getPublishedCatalog();
    for (const sku of ["FORECASTING", "REGULATED_ITEMS"]) {
      const def = published.addonSkus.find((s: any) => s.sku === sku);
      if (!def) throw new Error(`the published catalog has no ${sku}`);
      price[sku] = Number(def.monthlyPrice);
    }
    sw = new AutoLockSwitchService(prisma as any);
    events = new BillingEventService(prisma as any);
    const planTransition: any = {
      isEnabled: () => Promise.resolve(false),
      prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
      onPlanChange: () => Promise.resolve({ action: "none" }),
      transactionOptions: () => undefined,
      invalidateCaches: () => undefined,
    };
    cron = new BillingCronService(
      prisma as any,
      events,
      noop,
      noop,
      catalog,
      {} as any, // meters
      { notifyTrialEnding: jest.fn(), notifyDowngradeApplied: jest.fn() } as any,
      planTransition,
      stripeStub,
      {} as any, // scheduledPrice
      sw,
    );
    admin = new PlatformAdminService(
      prisma as any,
      noop, // jwtService
      noop, // config
      noop, // emailService
      noop, // billingService
      noop, // pricing
      catalog,
      new ProrationService(prisma as any, catalog),
      noop, // entitlementsService
      events,
      noop, // meterService
      noop, // tenantStatusGuard
      { log: jest.fn().mockResolvedValue(undefined) } as any, // auditService
      new MrrService(prisma as any),
      noop, // tenantMirror
      noop, // featureOverrides
      planTransition,
      stripeStub,
    );
    mutations = new SubscriptionMutationService(
      prisma as any,
      catalog,
      new ProrationService(prisma as any, catalog),
      { getSubscription: jest.fn().mockResolvedValue(undefined) } as any,
      noop,
      events,
      noop,
      stripeStub,
      { notifyUpgradeConfirmed: jest.fn() } as any,
      planTransition,
    );
  });

  afterAll(async () => {
    if (originalSwitch) {
      await prisma.platformConfig.upsert({
        where: { key: AUTO_LOCKS_PAUSED_KEY },
        create: { key: AUTO_LOCKS_PAUSED_KEY, value: originalSwitch.value },
        update: { value: originalSwitch.value },
      });
    } else {
      await prisma.platformConfig.deleteMany({ where: { key: AUTO_LOCKS_PAUSED_KEY } });
    }
    if (tenantIds.length) {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.billingNotificationLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await dropPublishedCatalog(prisma, createdVersionId);
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function unpaused() {
    await sw.setPaused(false, "sa787 db spec", null);
    sw.invalidate();
  }

  /** The matrix fixture: an ACTIVE paying tenant with an armed, past-due cancellation and rows a-e. */
  async function fixture(label: string) {
    seq += 1;
    const slug = assertTestTenant(`qa-sa787-${run}-${seq}-${label}`, SPEC);
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(t.id);
    await prisma.tenantSubscription.create({
      data: {
        tenantId: t.id,
        planKey: "GROWTH",
        basePriceSnapshot: 249,
        discount: 0,
        cycle: "MONTHLY",
        cancelAtPeriodEnd: true,
        periodStart: new Date(Date.now() - 31 * DAY),
        periodEnd: new Date(Date.now() - DAY),
        externalPayment: true,
      } as any,
    });
    const row = (addonKey: string, sku: string | null, over: Record<string, unknown>) =>
      prisma.tenantAddon.create({
        data: { tenantId: t.id, addonKey, sku, quantity: 1, active: true, ...over } as any,
      });
    await row("FORECASTING", "FORECASTING", {
      priceSnapshot: 25,
      stripeItemId: `si_a_${run}${seq}`,
    });
    await row("tobacco_dealer", null, { priceSnapshot: 39 });
    await row("MSRP", "MSRP", { priceSnapshot: 0, isComp: true });
    await row("OCR_PACK_250", "OCR_PACK_250", { priceSnapshot: 0 });
    await row("CUSTOMER_PACK_100", "CUSTOMER_PACK_100", { priceSnapshot: 12, active: false });
    return t.id;
  }

  const rows = async (tenantId: string) => {
    const all = await prisma.tenantAddon.findMany({ where: { tenantId } });
    const by = (key: string) => all.find((r) => r.addonKey === key)!;
    return {
      a: by("FORECASTING"),
      b: by("tobacco_dealer"),
      c: by("MSRP"),
      d: by("OCR_PACK_250"),
      e: by("CUSTOMER_PACK_100"),
    };
  };
  const delta = async (tenantId: string, type: string) =>
    (await prisma.billingEvent.findMany({ where: { tenantId, type } })).map((e) =>
      Number(e.amountDelta ?? 0),
    );
  const netMrr = async (tenantId: string) =>
    (await prisma.billingEvent.findMany({ where: { tenantId } })).reduce(
      (s, e) => s + Number(e.amountDelta ?? 0),
      0,
    );
  const lock = async (tenantId: string) => {
    await unpaused();
    await cron.applyScheduledCancellations();
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status).toBe(
      "READ_ONLY",
    );
  };

  it("M1: the lock alone leaves a-d ACTIVE (a's dead Stripe pointer cleared), (e) stays off; the churn delta is unchanged", async () => {
    const t = await fixture("m1");
    await lock(t);

    const r = await rows(t);
    expect([r.a.active, r.b.active, r.c.active, r.d.active, r.e.active]).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(r.a.stripeItemId).toBeNull();
    expect(
      [r.a, r.b, r.c, r.d].map((x) => [Number(x.priceSnapshot), x.isComp, x.quantity]),
    ).toEqual([
      [25, false, 1],
      [39, false, 1],
      [0, true, 1],
      [0, false, 1],
    ]);
    // Unchanged (guard): -(base 249 + a 25 + b 39); the comp and the $0 row contribute nothing.
    expect(await delta(t, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toEqual([-313]);
    const kept = (
      await prisma.billingEvent.findFirstOrThrow({
        where: { tenantId: t, type: BILLING_EVENTS.SUBSCRIPTION_CANCELED },
      })
    ).payload as any;
    expect(kept.addonsKept.map((k: any) => k.addonKey).sort()).toEqual([
      "FORECASTING",
      "MSRP",
      "OCR_PACK_250",
      "tobacco_dealer",
    ]);
  }, 60_000);

  it("M2: lock -> admin updateStatus ACTIVE: a-d are on, the crossing books +(base + a + b) once, net MRR 0, (e) stays off", async () => {
    const t = await fixture("m2");
    await lock(t);
    await admin.updateStatus(t, { status: "ACTIVE" } as any, null);

    const r = await rows(t);
    expect([r.a.active, r.b.active, r.c.active, r.d.active]).toEqual([true, true, true, true]);
    expect(r.e.active).toBe(false); // M9: never re-enabled
    expect(await delta(t, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toEqual([313]);
    expect(await netMrr(t)).toBe(0);
  }, 60_000);

  it("M3: lock -> activateManualSubscription: a-d are on, (a) and (b) are booked once, (e) stays off", async () => {
    const t = await fixture("m3");
    await lock(t);
    await admin.activateManualSubscription(
      t,
      { plan: "TEAM", billingPeriodDays: 30, paymentMethod: "BANK_TRANSFER" } as any,
      null,
    );

    const r = await rows(t);
    expect([r.a.active, r.b.active, r.c.active, r.d.active]).toEqual([true, true, true, true]);
    expect(r.e.active).toBe(false);
    expect((await delta(t, BILLING_EVENTS.ADDON_ENABLED)).sort((x, y) => x - y)).toEqual([25, 39]);
  }, 60_000);

  it("M4: lock -> checkout adoption on a NEW subscription: (a) is adopted onto its item, (b) is billed through one catalog-priced item, (c) and (d) are never billed", async () => {
    const t = await fixture("m4");
    await lock(t);
    const items: any[] = [
      {
        id: "si_base_new",
        quantity: 1,
        price: { unit_amount: 24900, product: { name: "Growth" } },
      },
      {
        id: "si_a_new",
        quantity: 1,
        metadata: { tenantId: t, sku: "FORECASTING" },
        price: {
          unit_amount: price.FORECASTING * 100,
          product: {
            name: "RouteFlow add-on - FORECASTING",
            metadata: { addonSku: "FORECASTING" },
          },
        },
      },
    ];
    let created = 0;
    const stripe: any = {
      isConfigured: true,
      client: {
        products: { create: jest.fn().mockResolvedValue({ id: "prod_new" }) },
        subscriptionItems: {
          list: jest.fn(async () => ({ data: items.map((i) => ({ ...i })) })),
          create: jest.fn(async (args: any) => {
            const item = {
              id: `si_created_${++created}`,
              quantity: args.quantity,
              metadata: args.metadata,
            };
            items.push(item);
            return item;
          }),
          update: jest.fn(),
          del: jest.fn(),
        },
      },
      getSubscription: jest.fn(async (id: string) => ({
        id,
        status: "active",
        customer: "cus_x",
        items: { data: items.map((i) => ({ ...i })) },
      })),
      retrieveSubscriptionWithDiscounts: jest
        .fn()
        .mockResolvedValue({ id: "sub_new", discounts: [] }),
      previewNextInvoice: jest.fn().mockResolvedValue(null),
    };
    await prisma.tenantSubscription.update({
      where: { tenantId: t },
      data: { stripeSubId: "sub_new" },
    });
    const m = new SubscriptionMutationService(
      prisma as any,
      catalog,
      new ProrationService(prisma as any, catalog),
      { getSubscription: jest.fn().mockResolvedValue(undefined) } as any,
      noop,
      events,
      noop,
      stripe,
      { notifyUpgradeConfirmed: jest.fn() } as any,
      {
        isEnabled: () => Promise.resolve(false),
        prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
        onPlanChange: () => Promise.resolve({ action: "none" }),
        transactionOptions: () => undefined,
        invalidateCaches: () => undefined,
      } as any,
    );
    await m.adoptCheckoutAddons(t, { id: "sub_new", items: { data: items } } as any, {} as any);

    const r = await rows(t);
    expect(r.a.stripeItemId).toBe("si_a_new");
    expect(r.b.stripeItemId).toMatch(/^si_created_/); // billed through ONE item at the catalog price
    expect(Number(r.b.priceSnapshot)).toBe(price.REGULATED_ITEMS);
    expect(stripe.client.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect([r.c.stripeItemId, r.d.stripeItemId]).toEqual([null, null]);
    expect(r.e.active).toBe(false);
  }, 60_000);

  it("M5: lock -> subscribe() naming (a): (b)-(d) stay on, (a) is booked in full once, (e) stays off", async () => {
    const t = await fixture("m5");
    await lock(t);
    // READ_ONLY(subscription_cancelled) + B58: subscribe() may refuse a same-plan pick from here. The builder
    // records which in the PR body; the add-on assertions below hold whenever the call is allowed through.
    const attempt = await mutations
      .subscribe(t, {
        planKey: "GROWTH",
        cycle: "MONTHLY",
        addons: [{ sku: "FORECASTING", quantity: 1 }],
      })
      .then(
        () => "ok" as const,
        (e: Error) => `refused: ${e.message}`,
      );
    const r = await rows(t);
    expect([r.b.active, r.c.active, r.d.active]).toEqual([true, true, true]);
    expect(r.e.active).toBe(false);
    if (attempt === "ok") {
      expect(r.a.active).toBe(true);
      expect(await delta(t, BILLING_EVENTS.ADDON_ENABLED)).toContain(25);
    }
  }, 60_000);

  it("M6: while locked, the regulated gate still answers (the add-on row is on) and the filing cron's predicate still matches the tenant", async () => {
    const t = await fixture("m6");
    await lock(t);
    const addons = new AddonService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      events,
      {} as any,
    );
    // Master: [] (the sweep switched it off): AddonGuard 403 ADDON_GATE and both regulated crons skipped the tenant.
    expect(await addons.getActiveAddons(t, { onlyKeys: ["tobacco_dealer"] })).toContain(
      "tobacco_dealer",
    );
    // regulated-filing-cron.service.ts reads exactly this predicate (SA-776 then gates on acceptsRecordKeeping).
    const packTenants = await prisma.tenantAddon.findMany({
      where: { addonKey: "tobacco_dealer", active: true, tenantId: t },
      select: { tenantId: true },
    });
    expect(packTenants).toHaveLength(1);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: t } })).status).toBe("READ_ONLY");
  }, 60_000);

  it("M7: the sweep runs again on the already READ_ONLY tenant: its filter excludes it, zero writes", async () => {
    const t = await fixture("m7");
    await lock(t);
    const before = await prisma.tenantAddon.findMany({
      where: { tenantId: t },
      orderBy: { addonKey: "asc" },
    });
    const eventsBefore = await prisma.billingEvent.count({ where: { tenantId: t } });

    await cron.applyScheduledCancellations();

    const after = await prisma.tenantAddon.findMany({
      where: { tenantId: t },
      orderBy: { addonKey: "asc" },
    });
    expect(after.map((x) => x.updatedAt.toISOString())).toEqual(
      before.map((x) => x.updatedAt.toISOString()),
    );
    expect(await prisma.billingEvent.count({ where: { tenantId: t } })).toBe(eventsBefore);
  }, 60_000);

  it("M8: a held lock (pause on) writes nothing; after the unpause the next tick does exactly what M1 does", async () => {
    const t = await fixture("m8");
    await sw.setPaused(true, "sa787 db spec hold", null);
    sw.invalidate();
    await cron.applyScheduledCancellations();
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: t } })).status).toBe("ACTIVE");
    expect((await rows(t)).a.stripeItemId).not.toBeNull(); // untouched while held

    await lock(t); // unpause + next tick
    const r = await rows(t);
    expect([r.a.active, r.b.active, r.c.active, r.d.active, r.e.active]).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(r.a.stripeItemId).toBeNull();
  }, 60_000);

  it("M9: the add-on the tenant disabled BEFORE the lock stays off through every reactivation path", async () => {
    const t = await fixture("m9");
    await lock(t);
    await admin.updateStatus(t, { status: "ACTIVE" } as any, null);
    expect((await rows(t)).e.active).toBe(false);
  }, 60_000);
});
