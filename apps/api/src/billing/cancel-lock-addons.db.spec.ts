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
import { AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { PlatformAdminService } from "../platform-admin/platform-admin.service";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";
import {
  buildCheckoutHarness,
  CATCHUP_PREPAID_METADATA,
} from "../testing/checkout-completed-harness";

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
  const names: Record<string, string> = {};
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
          { sku: "MSRP", name: "MSRP", monthlyPrice: 0 },
          { sku: "SALES_AGENTS", name: "Sales agents", monthlyPrice: 0 },
          { sku: "OCR_PACK_250", name: "OCR pack", monthlyPrice: 30 },
          { sku: "CUSTOMER_PACK_100", name: "Customer pack", monthlyPrice: 12 },
        ],
      },
      SPEC,
    );
    catalog = new PlanCatalogService(prisma as any);
    const published = await catalog.getPublishedCatalog();
    for (const sku of ["FORECASTING", "REGULATED_ITEMS", "MSRP", "SALES_AGENTS"]) {
      const def = published.addonSkus.find((s: any) => s.sku === sku);
      if (!def) throw new Error(`the published catalog has no ${sku}`);
      price[sku] = Number(def.monthlyPrice);
      names[sku] = def.name;
    }
    sw = new AutoLockSwitchService(prisma as any);
    events = new BillingEventService(prisma as any);
    const planTransition: any = {
      isEnabled: () => Promise.resolve(false),
      prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
      onPlanChange: () => Promise.resolve({ action: "none" }),
      // activateManualSubscription's interactive transaction reads `transactionOptions(prepared)`; under load the
      // default 5 s Prisma budget flaked M3, so the spec asks for the same widened budget the hook-on path uses.
      transactionOptions: () => ({ timeout: 30_000, maxWait: 30_000 }),
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

  /** An ACTIVE paying tenant with an armed, past-due cancellation and NO add-on rows. */
  async function newTenant(label: string) {
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
    return t.id;
  }

  const addRow = (
    tenantId: string,
    addonKey: string,
    sku: string | null,
    over: Record<string, unknown>,
  ) =>
    prisma.tenantAddon.create({
      data: { tenantId, addonKey, sku, quantity: 1, active: true, ...over } as any,
    });

  /** The matrix fixture: an ACTIVE paying tenant with an armed, past-due cancellation and rows a-e. */
  async function fixture(label: string) {
    const tenantId = await newTenant(label);
    const row = (addonKey: string, sku: string | null, over: Record<string, unknown>) =>
      addRow(tenantId, addonKey, sku, over);
    await row("FORECASTING", "FORECASTING", {
      priceSnapshot: 25,
      stripeItemId: `si_a_${run}${seq}`,
    });
    await row("tobacco_dealer", null, { priceSnapshot: 39 });
    await row("MSRP", "MSRP", { priceSnapshot: 0, isComp: true });
    await row("OCR_PACK_250", "OCR_PACK_250", { priceSnapshot: 0 });
    await row("CUSTOMER_PACK_100", "CUSTOMER_PACK_100", { priceSnapshot: 12, active: false });
    return tenantId;
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

  /**
   * A paid catch-up card checkout on a NEW subscription for a locked manual-pay tenant, as Stripe would deliver it:
   * the base item plus one checkout line per SKU in `lineSkus` (none for an add-on the session had no line for).
   * That path turns manual invoicing off in the apply transaction (isCatchupSession), so the add-on mode read at
   * adoption is STRIPE.
   */
  async function checkoutFor(t: string, tag: string, lineSkus: string[]) {
    const customer = `cus_${tag}`;
    const subId = `sub_${tag}`;
    await prisma.tenantSubscription.update({
      where: { tenantId: t },
      data: { stripeCustomerId: customer },
    });
    const addonItem = (id: string, sku: string, cents: number) => ({
      id,
      quantity: 1,
      metadata: { tenantId: t, sku },
      price: {
        unit_amount: cents,
        product: { name: `RouteFlow add-on - ${sku}`, metadata: { addonSku: sku } },
      },
    });
    const items: any[] = [
      {
        id: `si_base_${tag}`,
        quantity: 1,
        current_period_start: Math.floor((Date.now() - DAY) / 1000),
        current_period_end: Math.floor((Date.now() + 29 * DAY) / 1000),
        price: { unit_amount: 24900, product: { name: "Growth" } },
      },
      ...lineSkus.map((sku) => addonItem(`si_${sku}_${tag}`, sku, price[sku] * 100)),
    ];
    let created = 0;
    const subscription = () => ({
      id: subId,
      status: "active",
      customer,
      metadata: {},
      items: { data: items.map((i) => ({ ...i })) },
    });
    const stripe: any = {
      isConfigured: true,
      client: {
        products: { create: jest.fn().mockResolvedValue({ id: "prod_new" }) },
        subscriptionItems: {
          list: jest.fn(async () => ({ data: items.map((i) => ({ ...i })) })),
          create: jest.fn(async (args: any) => {
            const item = addonItem(
              `si_created_${tag}_${++created}`,
              args.metadata.sku,
              args.price_data.unit_amount,
            );
            items.push(item);
            return item;
          }),
          update: jest.fn(),
          del: jest.fn(async (id: string) => {
            const at = items.findIndex((i) => i.id === id);
            if (at >= 0) items.splice(at, 1); // a deleted item is gone from Stripe's list
            return { id };
          }),
        },
      },
      getSubscription: jest.fn(async () => subscription()),
      retrieveSubscriptionWithDiscounts: jest.fn().mockResolvedValue({ id: subId, discounts: [] }),
      previewNextInvoice: jest.fn().mockResolvedValue(null),
    };
    const harness = buildCheckoutHarness({ prisma, catalog, stripe, events, monthly: 249 });
    const session = {
      id: `cs_${tag}_${run}`,
      customer,
      subscription: subId,
      payment_status: "paid",
      created: Math.floor(Date.now() / 1000),
      metadata: { tenantId: t, planKey: "GROWTH", ...CATCHUP_PREPAID_METADATA },
    };
    return { harness, session, stripe, items };
  }

  it("M4: lock -> a paid catch-up checkout on a NEW subscription (onCheckoutCompleted): (a) is adopted onto its item, (b) is billed through one catalog-priced item, (c) and (d) are never billed, everything is booked once", async () => {
    const t = await fixture("m4");
    await lock(t);
    const { harness, session, stripe } = await checkoutFor(t, "m4", ["FORECASTING"]);

    await harness.complete(session);

    const r = await rows(t);
    expect(r.a.stripeItemId).toBe("si_FORECASTING_m4");
    expect(r.b.stripeItemId).toMatch(/^si_created_m4_/); // billed through ONE item at the catalog price
    expect(Number(r.b.priceSnapshot)).toBe(price.REGULATED_ITEMS);
    expect(stripe.client.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect([r.c.stripeItemId, r.d.stripeItemId]).toEqual([null, null]);
    expect(r.e.active).toBe(false);
    // Booked once: the reactivation crossing re-adds the run-rate the lock removed (base 249 + a 25 + b 39) and the
    // adoption's stored -> actual deltas are 0, so the net MRR is back to 0 and the crossing exists exactly once.
    expect(await delta(t, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toEqual([313]);
    expect(await netMrr(t)).toBe(0);

    // A redelivery of the same paid session changes nothing: no second item, nothing more booked.
    const eventsAfter = await prisma.billingEvent.count({ where: { tenantId: t } });
    await harness.complete(session);
    expect(stripe.client.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect(await prisma.billingEvent.count({ where: { tenantId: t } })).toBe(eventsAfter);
    expect(await netMrr(t)).toBe(0);
  }, 60_000);

  it("M5: lock -> subscribe() naming (a): (b)-(d) stay on, (a) is switched on and booked in full once, (e) stays off", async () => {
    const t = await fixture("m5");
    await lock(t);
    // READ_ONLY is not ACTIVE, so B58 (b58-guard.ts: only an ACTIVE same-cycle pick is refused) lets this through:
    // one outcome, pinned. A refusal here is a regression, not a branch.
    await mutations.subscribe(t, {
      planKey: "GROWTH",
      cycle: "MONTHLY",
      addons: [{ sku: "FORECASTING", quantity: 1 }],
    });

    const r = await rows(t);
    expect([r.a.active, r.b.active, r.c.active, r.d.active]).toEqual([true, true, true, true]);
    expect(r.e.active).toBe(false);
    // (a) at its FULL catalog amount, once; (b) is the kept admin-only row, booked once at its stored price.
    expect(Number(r.a.priceSnapshot)).toBe(price.FORECASTING);
    expect((await delta(t, BILLING_EVENTS.ADDON_ENABLED)).sort((x, y) => x - y)).toEqual([
      price.FORECASTING,
      price.REGULATED_ITEMS,
    ]);
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

  // ─── SA-815c / SA-815d: which active rows a card checkout puts on a Stripe item ─────────────────────────────────
  // The adoption's (c) loop (`isStripeBillableAddonRow`) bills an ADMIN-ONLY row only when its stored price is above
  // zero AND equals its billing catalog price; a mismatch is skipped untouched with one platform notice per row.
  // The reactivation crossing's BOOKING is unchanged (it books every active billable row at its stored price, so live
  // MRR and ledger MRR keep agreeing), which is why the net MRR is 0 after lock -> checkout in every case.

  const base = 249;
  const noticesOf = (tenantId: string) =>
    prisma.auditLog.findMany({
      where: { tenantId, action: AdminAuditAction.ADDON_PRICED_NOT_BILLED },
    });

  /** A locked tenant holding exactly `specs`, linked to a paid catch-up checkout that has NO add-on lines. */
  async function lockedWith(
    tag: string,
    specs: Array<{ addonKey: string; sku: string | null; over: Record<string, unknown> }>,
  ) {
    const t = await newTenant(tag);
    for (const s of specs) await addRow(t, s.addonKey, s.sku, s.over);
    await lock(t);
    return { t, ...(await checkoutFor(t, tag, [])) };
  }
  const onlyRow = async (tenantId: string) =>
    prisma.tenantAddon.findFirstOrThrow({ where: { tenantId } });

  it("N1: a priced admin-only row AT its catalog price -> exactly one Stripe item at that price, booked once, a redelivery is a no-op", async () => {
    const p = price.REGULATED_ITEMS;
    const { t, harness, session, stripe } = await lockedWith("n1", [
      { addonKey: "tobacco_dealer", sku: null, over: { priceSnapshot: p } },
    ]);

    await harness.complete(session);

    const r = await onlyRow(t);
    expect(stripe.client.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect(stripe.client.subscriptionItems.create.mock.calls[0][0].price_data.unit_amount).toBe(
      Math.round(p * 100),
    );
    expect(r.stripeItemId).toMatch(/^si_created_n1_/);
    expect(Number(r.priceSnapshot)).toBe(p);
    expect(await delta(t, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toEqual([base + p]);
    expect(await netMrr(t)).toBe(0);
    expect(await noticesOf(t)).toHaveLength(0);

    const eventsAfter = await prisma.billingEvent.count({ where: { tenantId: t } });
    await harness.complete(session);
    expect(stripe.client.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect(await prisma.billingEvent.count({ where: { tenantId: t } })).toBe(eventsAfter);
    expect(await netMrr(t)).toBe(0);
  }, 60_000);

  it("N2: a $0 admin-only row (its catalog price is above zero) -> no item, no notice, nothing booked for it", async () => {
    expect(price.REGULATED_ITEMS).toBeGreaterThan(0); // the catalog DOES price it: only the row's $0 keeps it out
    const { t, harness, session, stripe } = await lockedWith("n2", [
      { addonKey: "tobacco_dealer", sku: null, over: { priceSnapshot: 0 } },
    ]);

    await harness.complete(session);
    await harness.complete(session);

    const r = await onlyRow(t);
    expect(stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect([r.stripeItemId, Number(r.priceSnapshot), r.active]).toEqual([null, 0, true]);
    expect(await noticesOf(t)).toHaveLength(0);
    expect(await delta(t, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toEqual([base]);
    expect(await netMrr(t)).toBe(0);
  }, 60_000);

  it("N3: a priced COMP admin-only row -> no item, no notice, never booked", async () => {
    const { t, harness, session, stripe } = await lockedWith("n3", [
      { addonKey: "MSRP", sku: "MSRP", over: { priceSnapshot: 15, isComp: true } },
    ]);

    await harness.complete(session);

    const r = await onlyRow(t);
    expect(stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect([r.stripeItemId, Number(r.priceSnapshot)]).toEqual([null, 15]);
    expect(await noticesOf(t)).toHaveLength(0);
    expect(await delta(t, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toEqual([base]); // the comp is no revenue
    expect(await netMrr(t)).toBe(0);
  }, 60_000);

  it("N4: a priced SEAT_EXTRA row -> no item and no notice (seats bill through the plan quantity)", async () => {
    const { t, harness, session, stripe } = await lockedWith("n4", [
      { addonKey: "SEAT_EXTRA", sku: "SEAT_EXTRA", over: { priceSnapshot: 8 } },
    ]);

    await harness.complete(session);

    const r = await onlyRow(t);
    expect(stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect([r.stripeItemId, Number(r.priceSnapshot)]).toEqual([null, 8]);
    expect(await noticesOf(t)).toHaveLength(0);
    // The booking is untouched by SA-815d: the seat row's price is still on both sides of the pair.
    expect(await delta(t, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toEqual([base + 8]);
    expect(await netMrr(t)).toBe(0);
  }, 60_000);

  const MISMATCH_COPY = (name: string, money: string) =>
    `${name} is priced at ${money} for this workspace but has no card billing. Set up its billing at the agreed price.`;

  it("N5: a catalog-$0 admin-priced row (SALES_AGENTS) -> no item, the snapshot is untouched, ONE notice (a redelivery adds none)", async () => {
    expect(price.SALES_AGENTS).toBe(0);
    const { t, harness, session, stripe } = await lockedWith("n5", [
      { addonKey: "SALES_AGENTS", sku: "SALES_AGENTS", over: { priceSnapshot: 15 } },
    ]);

    await harness.complete(session);
    expect(await noticesOf(t)).toHaveLength(1);
    await harness.complete(session);

    const r = await onlyRow(t);
    expect(stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect([r.stripeItemId, Number(r.priceSnapshot), r.active]).toEqual([null, 15, true]);
    const notices = await noticesOf(t);
    expect(notices).toHaveLength(1);
    expect((notices[0].meta as any).message).toBe(MISMATCH_COPY(names.SALES_AGENTS, "$15.00"));
    // booking unchanged: the crossing books the stored price, so the pair nets to 0
    expect(await delta(t, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toEqual([base + 15]);
    expect(await netMrr(t)).toBe(0);
  }, 60_000);

  it.each([
    ["above", 6],
    ["below", -9],
  ])(
    "N6: a custom price %s the catalog (REGULATED_ITEMS) -> no item, the snapshot is untouched, ONE notice (a redelivery adds none)",
    async (_where, offset) => {
      const custom = price.REGULATED_ITEMS + offset;
      const { t, harness, session, stripe } = await lockedWith(`n6${offset > 0 ? "a" : "b"}`, [
        { addonKey: "tobacco_dealer", sku: null, over: { priceSnapshot: custom } },
      ]);

      await harness.complete(session);
      await harness.complete(session);

      const r = await onlyRow(t);
      expect(stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
      expect([r.stripeItemId, Number(r.priceSnapshot)]).toEqual([null, custom]);
      const notices = await noticesOf(t);
      expect(notices).toHaveLength(1);
      expect((notices[0].meta as any).message).toBe(
        MISMATCH_COPY(names.REGULATED_ITEMS, `$${custom.toFixed(2)}`),
      );
      expect(await delta(t, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toEqual([base + custom]);
      expect(await netMrr(t)).toBe(0);
    },
    60_000,
  );

  it("N7 (N1 review): a legacy-SKU row the catalog does not list, with a stale price above zero -> skipped with a notice, never silent", async () => {
    const { t, harness, session, stripe } = await lockedWith("n7", [
      { addonKey: "ROUTE_EXTRA", sku: "ROUTE_EXTRA", over: { priceSnapshot: 30 } },
    ]);

    await harness.complete(session);
    await harness.complete(session);

    const r = await onlyRow(t);
    expect(stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect([r.stripeItemId, Number(r.priceSnapshot)]).toEqual([null, 30]);
    const notices = await noticesOf(t);
    expect(notices).toHaveLength(1);
    expect((notices[0].meta as any).message).toBe(MISMATCH_COPY("ROUTE_EXTRA", "$30.00"));
  }, 60_000);

  it("N8 (S3): lock -> subscribe() -> the checkout completes: the later reactivation crossing never books (b) a second time", async () => {
    const t = await fixture("n8");
    await lock(t);
    await mutations.subscribe(t, {
      planKey: "GROWTH",
      cycle: "MONTHLY",
      addons: [{ sku: "FORECASTING", quantity: 1 }],
    });
    const afterSubscribe = {
      b: await delta(t, BILLING_EVENTS.ADDON_ENABLED),
      net: await netMrr(t),
      status: (await prisma.tenant.findUniqueOrThrow({ where: { id: t } })).status,
    };
    // subscribe() booked (a) and (b) once each, as M5 pins
    expect(afterSubscribe.b.sort((x, y) => x - y)).toEqual([
      price.FORECASTING,
      price.REGULATED_ITEMS,
    ]);

    const { harness, session } = await checkoutFor(t, "n8", ["FORECASTING"]);
    await harness.complete(session);

    // (b)'s price is on the ledger exactly once across both paths: one ADDON_ENABLED for it ...
    const enabled = (await delta(t, BILLING_EVENTS.ADDON_ENABLED)).sort((x, y) => x - y);
    expect(enabled).toEqual([price.FORECASTING, price.REGULATED_ITEMS]);
    // ... and the run-rate the lock removed (-313) is back exactly once: the net is 0, never +39 over.
    expect(await netMrr(t)).toBe(0);
  }, 60_000);

  // ─── SA-815d MUST-1: the predicate is enforced on the row ACTUALLY billed, not only at the (c) read ─────────────
  const AGED = () => new Date(Date.now() - 40 * DAY);

  it.each([
    ["a custom $29 row", 29],
    ["a $0 row", 0],
  ])(
    "O1: (c) accepts the $39 at-catalog row while an OLDER row of the same SKU family is %s -> only the accepted row gets the item; the older row is untouched; booked once",
    async (_label, oldPrice) => {
      const p = price.REGULATED_ITEMS;
      const { t, harness, session, stripe } = await lockedWith(`o1-${oldPrice}`, [
        {
          addonKey: "tobacco_dealer",
          sku: null,
          over: { priceSnapshot: oldPrice, createdAt: AGED() },
        },
        { addonKey: "REGULATED_ITEMS", sku: "REGULATED_ITEMS", over: { priceSnapshot: p } },
      ]);

      await harness.complete(session);

      const all = await prisma.tenantAddon.findMany({ where: { tenantId: t } });
      const older = all.find((r) => r.addonKey === "tobacco_dealer")!;
      const accepted = all.find((r) => r.addonKey === "REGULATED_ITEMS")!;
      expect(stripe.client.subscriptionItems.create).toHaveBeenCalledTimes(1);
      expect(accepted.stripeItemId).toMatch(/^si_created_/);
      expect(Number(accepted.priceSnapshot)).toBe(p);
      expect([older.stripeItemId, Number(older.priceSnapshot)]).toEqual([null, oldPrice]);
      // the crossing books both stored prices once; the adoption's stored -> actual delta on the accepted row is 0
      expect(await delta(t, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toEqual([base + oldPrice + p]);
      expect(await delta(t, BILLING_EVENTS.ADDON_ENABLED)).toEqual([]);
      expect(await netMrr(t)).toBe(0);
      expect(await noticesOf(t)).toHaveLength(oldPrice > 0 ? 1 : 0);

      const eventsAfter = await prisma.billingEvent.count({ where: { tenantId: t } });
      await harness.complete(session);
      expect(stripe.client.subscriptionItems.create).toHaveBeenCalledTimes(1);
      expect(await prisma.billingEvent.count({ where: { tenantId: t } })).toBe(eventsAfter);
    },
    60_000,
  );

  it("O2: an admin re-prices the row between the (c) read and the claim -> no item at the stale price (the created item is deleted, the webhook fails); the retry bills nothing and raises the notice", async () => {
    const p = price.REGULATED_ITEMS;
    const { t, harness, session, stripe } = await lockedWith("o2", [
      { addonKey: "tobacco_dealer", sku: null, over: { priceSnapshot: p } },
    ]);
    const create = stripe.client.subscriptionItems.create;
    const real = create.getMockImplementation()!;
    create.mockImplementationOnce(async (args: any) => {
      // after the item exists, before the claim
      await prisma.tenantAddon.updateMany({ where: { tenantId: t }, data: { priceSnapshot: 29 } });
      return real(args);
    });

    await expect(harness.complete(session)).rejects.toBeDefined();

    expect(create).toHaveBeenCalledTimes(1);
    expect(stripe.client.subscriptionItems.del).toHaveBeenCalledTimes(1);
    expect(stripe.client.subscriptionItems.del.mock.calls[0][0]).toMatch(/^si_created_o2_/);
    let r = await onlyRow(t);
    expect([r.stripeItemId, Number(r.priceSnapshot)]).toEqual([null, 29]); // no rewrite to the catalog price
    expect(await delta(t, BILLING_EVENTS.ADDON_ENABLED)).toEqual([]);

    await harness.complete(session); // the retry: a mismatch now
    r = await onlyRow(t);
    expect(create).toHaveBeenCalledTimes(1);
    expect([r.stripeItemId, Number(r.priceSnapshot)]).toEqual([null, 29]);
    const notices = await noticesOf(t);
    expect(notices).toHaveLength(1);
    expect((notices[0].meta as any).message).toBe(MISMATCH_COPY(names.REGULATED_ITEMS, "$29.00"));
  }, 60_000);

  it("O3: the notice copy re-reads the row's CURRENT price at send time", async () => {
    const { t } = await lockedWith("o3", [
      { addonKey: "tobacco_dealer", sku: null, over: { priceSnapshot: 15 } },
    ]);
    const r = await onlyRow(t);
    await prisma.tenantAddon.update({ where: { id: r.id }, data: { priceSnapshot: 22 } });

    await (mutations as any).noteAddonPricedNotBilled(
      t,
      r.id,
      "REGULATED_ITEMS",
      "Regulated",
      null,
    );

    const notices = await noticesOf(t);
    expect(notices).toHaveLength(1);
    expect((notices[0].meta as any).message).toBe(MISMATCH_COPY("Regulated", "$22.00"));
    expect((notices[0].meta as any).priceSnapshot).toBe(22);
  }, 60_000);

  it("O4: no notice when the checkout's subscription is no longer the tenant's stored one", async () => {
    const { t } = await lockedWith("o4", [
      { addonKey: "tobacco_dealer", sku: null, over: { priceSnapshot: 15 } },
    ]);
    const r = await onlyRow(t);

    // the tenant stores NO subscription id; the checkout's (sub_gone) was replaced
    await (mutations as any).noteAddonPricedNotBilled(
      t,
      r.id,
      "REGULATED_ITEMS",
      "Regulated",
      "sub_gone",
    );
    expect(await noticesOf(t)).toHaveLength(0);

    await (mutations as any).noteAddonPricedNotBilled(
      t,
      r.id,
      "REGULATED_ITEMS",
      "Regulated",
      null,
    );
    expect(await noticesOf(t)).toHaveLength(1);
  }, 60_000);
  // ─── G1a: a STRANDED card item (no row holds it) is removed on the admin-only skip path ───────────────────────────
  // An in-app item (metadata {tenantId, sku}, never the checkout's `addonSku` tag) that an earlier delivery adopted
  // (lost claim) or created (strict delete threw) keeps billing the customer when the retry re-judges the row as a
  // mismatch and returns. The skip path now removes it (strict, prorated), under the same add-on lock.
  /** `ageSeconds`: how long ago Stripe created the item (default: an hour, well past the sweep's age floor). */
  const inAppItem = (id: string, tenant: string, sku: string, ageSeconds = 3600) => ({
    id,
    quantity: 1,
    created: Math.floor(Date.now() / 1000) - ageSeconds,
    metadata: { tenantId: tenant, sku },
    price: { unit_amount: 3900 },
  });
  const strandedOf = (tenantId: string, action: string) =>
    prisma.auditLog.findMany({ where: { tenantId, action } });
  const delIds = (stripe: any) =>
    stripe.client.subscriptionItems.del.mock.calls.map((c: any[]) => c[0]);

  it("P1: an orphan adopted by a delivery that LOST its claim stays on the subscription; the retry's mismatch skip deletes it (prorated) and bills nothing", async () => {
    const p = price.REGULATED_ITEMS;
    const { t, harness, session, stripe, items } = await lockedWith("p1", [
      { addonKey: "tobacco_dealer", sku: null, over: { priceSnapshot: p } },
    ]);
    items.push(inAppItem("si_orph_p1", t, "REGULATED_ITEMS"));
    const list = stripe.client.subscriptionItems.list;
    const real = list.getMockImplementation()!;
    list.mockImplementationOnce(async (args: any) => {
      // the orphan is listed (and adopted), then an admin re-prices the row: the claim loses its compare-and-swap
      const out = await real(args);
      await prisma.tenantAddon.updateMany({ where: { tenantId: t }, data: { priceSnapshot: 29 } });
      return out;
    });

    await expect(harness.complete(session)).rejects.toBeDefined(); // first delivery fails, the orphan is left
    expect(delIds(stripe)).not.toContain("si_orph_p1");
    expect(items.map((i) => i.id)).toContain("si_orph_p1");

    await harness.complete(session); // the retry: a mismatch now

    expect(delIds(stripe)).toEqual(["si_orph_p1"]);
    expect(stripe.client.subscriptionItems.del).toHaveBeenCalledWith("si_orph_p1", {
      proration_behavior: "create_prorations",
    });
    expect(stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
    expect(items.map((i) => i.id)).not.toContain("si_orph_p1");
    const r = await onlyRow(t);
    expect([r.stripeItemId, Number(r.priceSnapshot)]).toEqual([null, 29]);
    expect(await noticesOf(t)).toHaveLength(1);
    const audit = await strandedOf(t, AdminAuditAction.ADDON_STRANDED_ITEM_REMOVED);
    expect(audit).toHaveLength(1);
    expect(audit[0].meta as any).toMatchObject({
      sku: "REGULATED_ITEMS",
      itemId: "si_orph_p1",
      reason: "stranded after a skipped admin-only bill",
    });
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t } });
    expect(sub.needsReconcile).toBe(false);
  }, 60_000);

  it("P2: an item ANY row of the tenant holds (active or inactive) is never deleted; an unreferenced one beside them is", async () => {
    const { t, harness, session, stripe, items } = await lockedWith("p2", [
      { addonKey: "tobacco_dealer", sku: null, over: { priceSnapshot: 29 } }, // a mismatch (catalog is higher)
      {
        addonKey: "REGULATED_ITEMS",
        sku: "REGULATED_ITEMS",
        over: { active: false, priceSnapshot: 39 },
      },
      { addonKey: "FORECASTING", sku: "FORECASTING", over: { priceSnapshot: 25 } },
    ]);
    // the lock cleared every pointer of the dead subscription: these two rows hold items of the NEW one
    await prisma.tenantAddon.updateMany({
      where: { tenantId: t, addonKey: "REGULATED_ITEMS" },
      data: { stripeItemId: "si_held_inactive_p2" },
    });
    await prisma.tenantAddon.updateMany({
      where: { tenantId: t, addonKey: "FORECASTING" },
      data: { stripeItemId: "si_held_active_p2" },
    });
    items.push(
      inAppItem("si_held_inactive_p2", t, "REGULATED_ITEMS"),
      inAppItem("si_held_active_p2", t, "REGULATED_ITEMS"),
      inAppItem("si_free_p2", t, "REGULATED_ITEMS"),
    );

    await harness.complete(session);

    expect(delIds(stripe)).toEqual(["si_free_p2"]);
    expect(items.map((i) => i.id)).toEqual(
      expect.arrayContaining(["si_held_inactive_p2", "si_held_active_p2"]),
    );
  }, 60_000);

  it("P3: another SKU's item, another tenant's item and the plan item on the same subscription are untouched", async () => {
    const { t, harness, session, stripe, items } = await lockedWith("p3", [
      { addonKey: "tobacco_dealer", sku: null, over: { priceSnapshot: 29 } },
    ]);
    items.push(
      inAppItem("si_other_sku_p3", t, "FORECASTING"),
      inAppItem("si_other_tenant_p3", "00000000-0000-0000-0000-00000000dead", "REGULATED_ITEMS"),
      inAppItem("si_mine_p3", t, "REGULATED_ITEMS"),
    );

    await harness.complete(session);

    expect(delIds(stripe)).toEqual(["si_mine_p3"]);
    expect(items.map((i) => i.id)).toEqual(
      expect.arrayContaining([`si_base_p3`, "si_other_sku_p3", "si_other_tenant_p3"]),
    );
  }, 60_000);

  it("P4: a delete that throws -> the tenant is flagged for reconcile, ONE notice names the item, and the webhook still resolves", async () => {
    const { t, harness, session, stripe, items } = await lockedWith("p4", [
      { addonKey: "tobacco_dealer", sku: null, over: { priceSnapshot: 29 } },
    ]);
    items.push(inAppItem("si_stuck_p4", t, "REGULATED_ITEMS"));
    stripe.client.subscriptionItems.del.mockRejectedValue(new Error("stripe is down"));

    await expect(harness.complete(session)).resolves.toBeUndefined();
    await harness.complete(session); // a redelivery adds no second notice

    expect(items.map((i) => i.id)).toContain("si_stuck_p4");
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t } });
    expect(sub.needsReconcile).toBe(true);
    expect(await strandedOf(t, AdminAuditAction.ADDON_STRANDED_ITEM_REMOVED)).toHaveLength(0);
    const stuck = await strandedOf(t, AdminAuditAction.ADDON_STRANDED_ITEM_STUCK);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].meta as any).toMatchObject({
      sku: "REGULATED_ITEMS",
      itemIds: ["si_stuck_p4"],
    });
    expect(await noticesOf(t)).toHaveLength(1); // the mismatch notice is unaffected
  }, 60_000);
  it("P5: a created item whose strict delete THREW (after a lost claim) is removed by the retry's mismatch skip", async () => {
    const p = price.REGULATED_ITEMS;
    const { t, harness, session, stripe, items } = await lockedWith("p5", [
      { addonKey: "tobacco_dealer", sku: null, over: { priceSnapshot: p } },
    ]);
    const create = stripe.client.subscriptionItems.create;
    create.mockImplementationOnce(async (args: any) => {
      await prisma.tenantAddon.updateMany({ where: { tenantId: t }, data: { priceSnapshot: 29 } });
      // an in-app item (metadata only), as the enable path makes it: never the checkout's `addonSku` tag
      const item = inAppItem("si_created_p5_1", t, args.metadata.sku, 700); // by the retry it is old enough
      items.push(item);
      return item;
    });
    stripe.client.subscriptionItems.del.mockRejectedValueOnce(new Error("stripe is down"));

    await expect(harness.complete(session)).rejects.toBeDefined();
    const createdId = items.find((i) => String(i.id).startsWith("si_created_p5_"))?.id;
    expect(createdId).toBeDefined(); // the strict delete failed: the item is still on the subscription

    await harness.complete(session); // the retry: a mismatch now

    expect(stripe.client.subscriptionItems.del).toHaveBeenLastCalledWith(createdId, {
      proration_behavior: "create_prorations",
    });
    expect(items.map((i) => i.id)).not.toContain(createdId);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await strandedOf(t, AdminAuditAction.ADDON_STRANDED_ITEM_REMOVED)).toHaveLength(1);
  }, 60_000);

  it("P6: the in-lock skip (a row re-priced AFTER the (c) read) removes the stranded item too", async () => {
    const { t, harness, stripe, items } = await lockedWith("p6", [
      { addonKey: "tobacco_dealer", sku: null, over: { priceSnapshot: 29 } },
    ]);
    items.push(inAppItem("si_orph_p6", t, "REGULATED_ITEMS"));
    const row = await onlyRow(t);

    const billed = await (harness.mutations as any).billUnbilledRow(
      t,
      "REGULATED_ITEMS",
      row,
      "sub_p6",
      null,
      { sessionId: "cs_p6" },
      { adminOnly: true },
    );

    expect(billed).toBe(false);
    expect(delIds(stripe)).toEqual(["si_orph_p6"]);
    expect(stripe.client.subscriptionItems.create).not.toHaveBeenCalled();
  }, 60_000);
  it("P7: an unclaimed owned item created just now (a concurrent delivery may be about to claim it) is NOT deleted; no removed/stuck audit", async () => {
    const { t, harness, session, stripe, items } = await lockedWith("p7", [
      { addonKey: "tobacco_dealer", sku: null, over: { priceSnapshot: 29 } },
    ]);
    items.push(
      inAppItem("si_now_p7", t, "REGULATED_ITEMS", 0),
      inAppItem("si_young_p7", t, "REGULATED_ITEMS", 599),
    );

    await harness.complete(session);

    expect(stripe.client.subscriptionItems.del).not.toHaveBeenCalled();
    expect(items.map((i) => i.id)).toEqual(expect.arrayContaining(["si_now_p7", "si_young_p7"]));
    expect(await strandedOf(t, AdminAuditAction.ADDON_STRANDED_ITEM_REMOVED)).toHaveLength(0);
    expect(await strandedOf(t, AdminAuditAction.ADDON_STRANDED_ITEM_STUCK)).toHaveLength(0);
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t } });
    expect(sub.needsReconcile).toBe(false);
  }, 60_000);

  it("P8: an unclaimed owned item created 11 minutes ago IS deleted (the young one beside it is not)", async () => {
    const { t, harness, session, stripe, items } = await lockedWith("p8", [
      { addonKey: "tobacco_dealer", sku: null, over: { priceSnapshot: 29 } },
    ]);
    items.push(
      inAppItem("si_old_p8", t, "REGULATED_ITEMS", 11 * 60),
      inAppItem("si_now_p8", t, "REGULATED_ITEMS", 0),
    );

    await harness.complete(session);

    expect(delIds(stripe)).toEqual(["si_old_p8"]);
    expect(items.map((i) => i.id)).toContain("si_now_p8");
    expect(await strandedOf(t, AdminAuditAction.ADDON_STRANDED_ITEM_REMOVED)).toHaveLength(1);
  }, 60_000);
});
