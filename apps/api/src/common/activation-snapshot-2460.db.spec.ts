/**
 * DB-lane spec for #2460 — SA-464, against real Postgres. One invariant (SA-444a):
 * `basePriceSnapshot` = what the tenant pays, so per tenant the SNAPSHOT MRR (MrrService's per-row
 * pricing of a paying row) always equals the LEDGER MRR (Σ BillingEvent.amountDelta).
 *
 * (1) `PlatformAdminService.activateManualSubscription`: only on a crossing INTO the paying set it
 *     snapshots `priceOverrideMonthly ?? catalog price` and books that contribution; renewing an
 *     already-ACTIVE row writes nothing (a legacy NULL stays NULL); free = an explicit override 0.
 * (2) `SubscriptionMutationService.upgrade()` and `PlatformAdminService.updatePlan()` net the ledger
 *     against the stored snapshot (NULL ⇒ 0), never the catalog price of the plan being left.
 *
 * Every step goes through the PUBLIC service methods on a REAL PrismaClient + real
 * BillingEventService / MrrService / PlanCatalogService / ProrationService, with stand-ins only for
 * collaborators these methods never touch (same construction as override-activation-ledger.db.spec.ts,
 * plus a real ProrationService because updatePlan quotes a proration). Tenants are throwaway `qa-*`
 * slugs (assertTestTenant); afterAll removes exactly those. The spec reuses a PUBLISHED catalog when
 * one exists and otherwise provisions STARTER/GROWTH/SCALE, removing only what it created.
 *
 * Run via `npm run local:test:db` (compose Postgres) — collected only by `jest.db.config.js`.
 */
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";
import { PlatformAdminService } from "../platform-admin/platform-admin.service";
import { SubscriptionMutationService } from "../billing/subscription-mutation.service";
import { BillingEventService } from "../billing/billing-event.service";
import { MrrService, isPayingRow } from "../billing/mrr.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { ProrationService } from "../billing/proration.service";
import { BillingService } from "../billing/billing.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "#2460 SA-464 — manual activation snapshots what it books; snapshot MRR = ledger MRR",
  () => {
    let pool: Pool;
    let prisma: PrismaClient;
    let platformAdmin: PlatformAdminService;
    let mutation: SubscriptionMutationService;
    let mrr: MrrService;
    const tenantIds: string[] = [];
    const run = randomUUID().slice(0, 8);
    let createdVersionId: string | undefined;
    const price: Record<string, number> = {};

    const planTransitionStub = {
      isEnabled: () => Promise.resolve(false),
      prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
      onPlanChange: () => Promise.resolve({ action: "none" }),
      transactionOptions: () => undefined,
      invalidateCaches: () => undefined,
    } as any;

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const published = await prisma.planVersion.findFirst({ where: { status: "PUBLISHED" } });
      if (!published) {
        // int4 column — never derive from Date.now()
        const version =
          ((await prisma.planVersion.aggregate({ _max: { version: true } }))._max.version ?? 0) + 1;
        const created = await prisma.planVersion.create({
          data: {
            version,
            status: "PUBLISHED",
            publishedAt: new Date(),
            notes: "qa fixture — created by activation-snapshot-2460.db.spec.ts",
            definitions: {
              create: [
                {
                  planKey: "STARTER",
                  name: "Starter",
                  monthlyPrice: 99,
                  isCustom: false,
                  featureFlags: [],
                },
                {
                  planKey: "GROWTH",
                  name: "Growth",
                  monthlyPrice: 249,
                  isCustom: false,
                  featureFlags: [],
                },
                {
                  planKey: "SCALE",
                  name: "Scale",
                  monthlyPrice: 499,
                  isCustom: false,
                  featureFlags: [],
                },
              ],
            },
          },
        });
        createdVersionId = created.id;
      }
      const inPlay = await prisma.planVersion.findFirstOrThrow({
        where: { status: "PUBLISHED" },
        include: { definitions: true },
      });
      for (const d of inPlay.definitions) price[d.planKey] = Number(d.monthlyPrice ?? 0);
      for (const k of ["STARTER", "GROWTH", "SCALE"]) expect(price[k]).toBeGreaterThan(0);
      expect(price.GROWTH).toBeGreaterThan(price.STARTER);
      expect(price.SCALE).toBeGreaterThan(price.GROWTH);

      const noop = {} as any;
      const catalog = new PlanCatalogService(prisma as any);
      const events = new BillingEventService(prisma as any);
      const proration = new ProrationService(prisma as any, catalog);
      mrr = new MrrService(prisma as any);

      // F2 (#938): the Pricing step must run the REAL reconcile path — updateTenantPriceOverride awaits
      // syncStripeSubscriptionPrice, whose reconcilePriceLedger rewrites the snapshot and books the Δ.
      // A real BillingService; the Stripe push is a natural no-op here (these rows have no
      // stripeSubId), and the tenant's price resolves from its own row (override ?? catalog).
      const pricing = {
        resolveTenantPricing: async (tenantId: string) => {
          const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });
          const monthly =
            sub.priceOverrideMonthly != null
              ? Number(sub.priceOverrideMonthly)
              : (price[sub.planKey ?? "STARTER"] ?? 0);
          return {
            planKey: sub.planKey,
            planName: sub.planKey,
            monthly,
            annual: monthly * 10,
            source: sub.priceOverrideMonthly != null ? "override" : "catalog",
            currency: "usd",
          };
        },
      };
      const billing = new BillingService(
        prisma as any,
        { isConfigured: true } as any, // stripe — no stripeSubId, so no Stripe call is made
        { send: jest.fn().mockResolvedValue({}) } as any, // email
        { invalidate: jest.fn() } as any, // tenantStatusGuard
        events,
        pricing as any,
        { notifyCancelled: jest.fn(), notifySuspended: jest.fn() } as any, // billingNotification
        planTransitionStub,
        {
          checkoutAddonLines: async () => ({ lineItems: [], skus: [] }),
          adoptCheckoutAddons: async () => undefined,
        } as any, // mutations (SA-690)
      );

      platformAdmin = new PlatformAdminService(
        prisma as any,
        noop, // jwtService
        noop, // config
        noop, // emailService
        billing, // billingService — the real reconcile path (F2)
        pricing as any, // platformPricingService
        catalog,
        proration, // updatePlan quotes a proration
        { invalidate: jest.fn() } as any, // entitlementsService — updatePlan invalidates (F2)
        events,
        noop, // meterService
        { invalidate: jest.fn() } as any, // tenantStatusGuard
        { log: jest.fn().mockResolvedValue(undefined) } as any, // auditService
        mrr,
        noop, // tenantMirror
        noop, // featureOverrides
        planTransitionStub,
        noop, // stripe
      );
      mutation = new SubscriptionMutationService(
        prisma as any,
        catalog,
        proration,
        { getSubscription: jest.fn().mockResolvedValue(undefined) } as any, // subscription
        { invalidate: jest.fn() } as any, // entitlementsService
        events,
        { invalidate: jest.fn() } as any, // tenantStatus
        noop, // stripe — upgrade() never calls it
        { notifyUpgradeConfirmed: jest.fn().mockResolvedValue(undefined) } as any, // billingNotification
        planTransitionStub,
      );
    });

    afterAll(async () => {
      if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      if (createdVersionId) {
        await prisma.planDefinition.deleteMany({ where: { planVersionId: createdVersionId } });
        await prisma.planVersion.delete({ where: { id: createdVersionId } });
      }
      await prisma.$disconnect();
      await pool.end();
    });

    async function makeTenant(
      tag: string,
      status: TenantStatus,
      sub?: {
        planKey: string | null;
        basePriceSnapshot: number | null;
        cycle?: "MONTHLY" | "ANNUAL";
      },
    ): Promise<string> {
      const slug = assertTestTenant(
        `qa-b2460-${tag}-${run}`,
        "activation-snapshot-2460.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({
        data: { slug, name: slug, class: TenantClass.PRODUCTION, status },
      });
      tenantIds.push(tenant.id);
      if (sub) {
        await prisma.tenantSubscription.create({
          data: {
            tenantId: tenant.id,
            planKey: sub.planKey,
            basePriceSnapshot: sub.basePriceSnapshot,
            discount: 0,
            ...(sub.cycle ? { cycle: sub.cycle } : {}),
          },
        });
      }
      return tenant.id;
    }

    /** Σ BillingEvent.amountDelta for the tenant (its ledger MRR). */
    async function ledger(tenantId: string): Promise<number> {
      const rows = await prisma.billingEvent.findMany({
        where: { tenantId },
        select: { amountDelta: true },
      });
      return Math.round(rows.reduce((s, r) => s + Number(r.amountDelta ?? 0), 0) * 100) / 100;
    }

    /** The tenant's snapshot MRR: MrrService's per-row pricing when the row is paying, else 0. */
    async function snapshot(tenantId: string): Promise<number> {
      const t = await prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          status: true,
          class: true,
          deletedAt: true,
          subscription: { select: { planKey: true, basePriceSnapshot: true, discount: true } },
        },
      });
      if (!t.subscription || !isPayingRow(t, t.subscription.planKey)) return 0;
      return mrr.priceSubscription(
        { basePriceSnapshot: t.subscription.basePriceSnapshot, discount: t.subscription.discount },
        [],
      );
    }

    const figures = async (tenantId: string) => ({
      snapshot: await snapshot(tenantId),
      ledger: await ledger(tenantId),
    });
    const activate = (tenantId: string, plan = "STARTER") =>
      platformAdmin.activateManualSubscription(
        tenantId,
        { plan, paymentMethod: "ZELLE", paymentRef: "ref", billingPeriodDays: 30 } as any,
        "admin-2460",
      );

    it("activation → upgrade → admin updatePlan → Pricing: snapshot MRR = ledger MRR after every step", async () => {
      const id = await makeTenant("chain", TenantStatus.TRIAL);

      await activate(id);
      expect(await figures(id)).toEqual({ snapshot: price.STARTER, ledger: price.STARTER });

      await mutation.upgrade(id, "GROWTH", "admin-2460");
      expect(await figures(id)).toEqual({ snapshot: price.GROWTH, ledger: price.GROWTH });

      await platformAdmin.updatePlan(id, { plan: "SCALE" } as any, "admin-2460");
      expect(await figures(id)).toEqual({ snapshot: price.SCALE, ledger: price.SCALE });

      await platformAdmin.updateTenantPriceOverride(id, { monthly: 150 } as any, "admin-2460");
      expect(await figures(id)).toEqual({ snapshot: 150, ledger: 150 });
    });

    it("a negotiated override: activation books the fee, a later upgrade keeps it (Δ0); figures equal", async () => {
      const id = await makeTenant("override", TenantStatus.TRIAL, {
        planKey: "STARTER",
        basePriceSnapshot: null,
      });
      await platformAdmin.updateTenantPriceOverride(id, { monthly: 123 } as any, "admin-2460");
      expect(await figures(id)).toEqual({ snapshot: 0, ledger: 0 }); // TRIAL: not paying yet (B864)

      await activate(id);
      expect(await figures(id)).toEqual({ snapshot: 123, ledger: 123 });

      await mutation.upgrade(id, "GROWTH", "admin-2460");
      expect(await figures(id)).toEqual({ snapshot: 123, ledger: 123 });
      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
      expect(Number(sub.priceOverrideMonthly)).toBe(123);
    });

    it("free = an explicit override 0: activation snapshots 0 and books Δ0", async () => {
      const id = await makeTenant("free", TenantStatus.TRIAL, {
        planKey: "STARTER",
        basePriceSnapshot: null,
      });
      await platformAdmin.updateTenantPriceOverride(id, { monthly: 0 } as any, "admin-2460");

      await activate(id);

      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
      expect(sub.basePriceSnapshot).not.toBeNull();
      expect(Number(sub.basePriceSnapshot)).toBe(0);
      expect(await figures(id)).toEqual({ snapshot: 0, ledger: 0 });
    });

    it("renewing an already-ACTIVE legacy row (NULL snapshot) writes no snapshot and books nothing", async () => {
      const id = await makeTenant("legacy", TenantStatus.ACTIVE, {
        planKey: "STARTER",
        basePriceSnapshot: null,
      });

      await activate(id);

      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
      expect(sub.basePriceSnapshot).toBeNull();
      expect(await prisma.billingEvent.count({ where: { tenantId: id } })).toBe(0);
    });

    it("re-activating an ACTIVE row writes nothing new; lapse → re-activate books the price exactly once", async () => {
      const id = await makeTenant("lapse", TenantStatus.TRIAL);
      await activate(id);
      const afterFirst = await prisma.billingEvent.count({ where: { tenantId: id } });

      await activate(id); // renewal of an ACTIVE row
      expect(await prisma.billingEvent.count({ where: { tenantId: id } })).toBe(afterFirst);
      expect(await figures(id)).toEqual({ snapshot: price.STARTER, ledger: price.STARTER });

      await platformAdmin.updateStatus(id, { status: "SUSPENDED" } as any, "admin-2460"); // lapse
      expect(await figures(id)).toEqual({ snapshot: 0, ledger: 0 });

      await activate(id); // re-activate: the price enters once
      expect(await figures(id)).toEqual({ snapshot: price.STARTER, ledger: price.STARTER });
    });

    it("a catalog row upgraded from a NULL snapshot books the full new price and the figures re-agree", async () => {
      const id = await makeTenant("nullup", TenantStatus.ACTIVE, {
        planKey: "STARTER",
        basePriceSnapshot: null,
      });
      expect(await figures(id)).toEqual({ snapshot: 0, ledger: 0 });

      await mutation.upgrade(id, "GROWTH", "admin-2460");

      expect(await figures(id)).toEqual({ snapshot: price.GROWTH, ledger: price.GROWTH });
    });

    // SA-464a condition: subscribe()'s re-entry nets against the snapshot its LOCKED re-read selects
    // (the select #2460 added) — executed here on real Postgres, not a mock. An ACTIVE NULL-snapshot
    // row re-choosing its plan (a cycle switch, which the B58 guard allows) books the full new price.
    it("subscribe() re-choice on an ACTIVE NULL-snapshot row books the full new price; figures re-agree", async () => {
      const id = await makeTenant("resub", TenantStatus.ACTIVE, {
        planKey: "STARTER",
        basePriceSnapshot: null,
        cycle: "ANNUAL",
      });
      expect(await figures(id)).toEqual({ snapshot: 0, ledger: 0 });

      await mutation.subscribe(id, { planKey: "GROWTH", cycle: "MONTHLY" } as any, "admin-2460");

      expect(await figures(id)).toEqual({ snapshot: price.GROWTH, ledger: price.GROWTH });
    });

    // #2522 / SA-464f: a renewal of an already-paying row that also switches plan is a ranked plan
    // change — rebase the snapshot onto the new plan and book Δ = newBase − (stored ?? 0), same tx.
    it("#2522 STARTER → GROWTH activation on an ACTIVE row: snapshot = GROWTH, figures equal", async () => {
      const id = await makeTenant("switch", TenantStatus.TRIAL);
      await activate(id);
      expect(await figures(id)).toEqual({ snapshot: price.STARTER, ledger: price.STARTER });
      const seen = (
        await prisma.billingEvent.findMany({ where: { tenantId: id }, select: { id: true } })
      ).map((e) => e.id);

      await activate(id, "GROWTH");

      // #2570 (the lead's nit on #2568): the switch books EXACTLY ONE plan.changed, at
      // +(GROWTH − STARTER) — not merely a ledger sum that happens to agree.
      const booked = await prisma.billingEvent.findMany({
        where: { tenantId: id, id: { notIn: seen } },
        select: { type: true, amountDelta: true },
      });
      expect(booked.map((e) => [e.type, Number(e.amountDelta ?? 0)])).toEqual([
        ["plan.changed", price.GROWTH - price.STARTER],
      ]);

      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
      expect(sub.planKey).toBe("GROWTH");
      expect(Number(sub.basePriceSnapshot)).toBe(price.GROWTH);
      expect(await figures(id)).toEqual({ snapshot: price.GROWTH, ledger: price.GROWTH });
    });

    it("#2522 an override row switching plan on activation keeps its fee and books Δ0", async () => {
      const id = await makeTenant("switchfee", TenantStatus.TRIAL, {
        planKey: "STARTER",
        basePriceSnapshot: null,
      });
      await platformAdmin.updateTenantPriceOverride(id, { monthly: 123 } as any, "admin-2460");
      await activate(id);
      const seen = (
        await prisma.billingEvent.findMany({ where: { tenantId: id }, select: { id: true } })
      ).map((e) => e.id);

      await activate(id, "GROWTH");

      const deltas = await prisma.billingEvent.findMany({
        where: { tenantId: id, id: { notIn: seen } },
        select: { amountDelta: true },
      });
      expect(deltas.map((d) => Number(d.amountDelta ?? 0))).toEqual([0]);
      expect(await figures(id)).toEqual({ snapshot: 123, ledger: 123 });
    });

    it("#2522 a legacy NULL-snapshot ACTIVE row switching plan self-heals; same-plan renewal after writes nothing", async () => {
      const id = await makeTenant("switchnull", TenantStatus.ACTIVE, {
        planKey: "STARTER",
        basePriceSnapshot: null,
      });

      await activate(id, "GROWTH");
      expect(await figures(id)).toEqual({ snapshot: price.GROWTH, ledger: price.GROWTH });

      const count = await prisma.billingEvent.count({ where: { tenantId: id } });
      await activate(id, "GROWTH"); // same-plan renewal
      expect(await prisma.billingEvent.count({ where: { tenantId: id } })).toBe(count);
      expect(await figures(id)).toEqual({ snapshot: price.GROWTH, ledger: price.GROWTH });
    });

    // #2583 / SA-513: upgrade() books on the shared paying predicate. A TEST-class tenant is outside
    // the paying set on both sides, so its upgrade books Δ0 (the ledger sum is unchanged) while the
    // snapshot still moves; flipping it to PRODUCTION then rebases from that stored snapshot.
    it("#2583: a TEST-class upgrade moves the snapshot but books nothing; class → PRODUCTION rebases from it", async () => {
      const id = await makeTenant("testcls", TenantStatus.ACTIVE, {
        planKey: "STARTER",
        basePriceSnapshot: price.STARTER,
      });
      await prisma.tenant.update({ where: { id }, data: { class: TenantClass.TEST } });
      expect(await figures(id)).toEqual({ snapshot: 0, ledger: 0 });

      await mutation.upgrade(id, "GROWTH", "admin-2583");

      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
      expect(sub.planKey).toBe("GROWTH");
      expect(Number(sub.basePriceSnapshot)).toBe(price.GROWTH); // the snapshot still moves
      const booked = await prisma.billingEvent.findMany({
        where: { tenantId: id, amountDelta: { not: 0 } },
        select: { type: true },
      });
      expect(booked).toEqual([]); // nothing booked for a non-paying row
      // SA-513a: the upgrade still leaves exactly ONE plan.changed history row, at Δ0.
      const planChanged = await prisma.billingEvent.findMany({
        where: { tenantId: id, type: "plan.changed" },
        select: { amountDelta: true },
      });
      expect(planChanged.map((e) => Number(e.amountDelta ?? 0))).toEqual([0]);
      expect(await figures(id)).toEqual({ snapshot: 0, ledger: 0 }); // MRR unchanged

      await platformAdmin.updateTenantClass(id, { class: "PRODUCTION" } as any, "admin-2583");
      expect(await figures(id)).toEqual({ snapshot: price.GROWTH, ledger: price.GROWTH });
    });
  },
);
