/**
 * SA-1099 A-3 note 2 (F-WP5-1) - real Postgres. `subscribe({ planKey, addons })` judges a self-serve add-on on the TARGET
 * plan before any write: the unit rows (subscription-mutation.subscribe-target-plan.spec.ts) pin the decision over mocks;
 * what only a real database shows is pinned here, with the REAL FeaturePreviewService (real add-on and override reads),
 * SubscriptionMutationService, ProrationService and BillingEventService over real rows and the real transaction.
 *
 *   DB-1  a TRIAL workspace picks Starter with FORECASTING, switch off (courtesy serves both flags) -> 409
 *         ADDON_ALREADY_INCLUDED, and NOTHING is written: the plan, the add-on rows, the subscription and the ledger stay.
 *   DB-2  the same pick with the switch "on" (no courtesy) -> sells: plan moves, an active FORECASTING row at its price.
 *   DB-3  the same pick with the capacity SKU, switch off -> sells (a capacity SKU is never "already had").
 *   DB-4  (S6, A-5) an ACTIVE workspace holding a FORECASTING row picks SCALE, which bundles it -> a keep: the plan moves
 *         and the row stays active (not judged, not refused).
 *   DB-5  (S7) the same pick with NO row -> 409 ADDON_INCLUDED_IN_PLAN, and nothing is written.
 *
 * The catalog is a stand-in (the plan graph under test) borrowing a real PlanVersion id for the FKs; Stripe is a stateful
 * fake. Throwaway `qa-*` tenants (assertTestTenant).
 */
import "reflect-metadata";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BillingEventService } from "./billing-event.service";
import { ProrationService } from "./proration.service";
import { FeatureOverrideService } from "./feature-override.service";
import { FeaturePreviewService } from "./feature-preview.service";
import { fakeStripeSubscription } from "../testing/fake-stripe-subscription";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { BILLING_EVENTS } from "./plan-catalog.constants";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "F-WP5-1 subscribe() judges a self-serve add-on on the target plan (real Postgres)",
  () => {
    let pool: Pool;
    let prisma: PrismaClient;
    let versionId: string;
    let createdVersionId: string | undefined;
    const tenantIds: string[] = [];
    const run = randomUUID().slice(0, 8);
    const saved = process.env.PLAN_FLAG_ENFORCEMENT;
    let seq = 0;

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
      const published = await prisma.planVersion.findFirst({ where: { status: "PUBLISHED" } });
      if (published) {
        versionId = published.id;
      } else {
        const version =
          ((await prisma.planVersion.aggregate({ _max: { version: true } }))._max.version ?? 0) + 1;
        const created = await prisma.planVersion.create({
          data: {
            version,
            status: "PUBLISHED",
            publishedAt: new Date(),
            notes: "qa fixture - created by subscribe-target-plan.db.spec.ts",
          },
        });
        createdVersionId = versionId = created.id;
      }
    });

    afterEach(() => {
      if (saved === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
      else process.env.PLAN_FLAG_ENFORCEMENT = saved;
    });

    afterAll(async () => {
      if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      if (createdVersionId) await prisma.planVersion.delete({ where: { id: createdVersionId } });
      await prisma.$disconnect();
      await pool.end();
    });

    /** Starter carries no Forecasting flag; FORECASTING grants both of its flags; the pack is a capacity SKU. */
    const catalog = () => ({
      id: versionId,
      definitions: [
        {
          planKey: "STARTER",
          name: "Starter",
          monthlyPrice: 59,
          annualPrice: null,
          isCustom: false,
          featureFlags: ["flag.msrp"],
        },
        {
          planKey: "GROWTH",
          name: "Growth",
          monthlyPrice: 249,
          annualPrice: null,
          isCustom: false,
          featureFlags: ["flag.msrp"],
        },
        {
          planKey: "SCALE",
          name: "Scale",
          monthlyPrice: 499,
          annualPrice: null,
          isCustom: false,
          featureFlags: ["flag.msrp", "flag.forecasting", "flag.analytics"],
        },
      ],
      addonSkus: [
        {
          sku: "FORECASTING",
          name: "Forecasting",
          monthlyPrice: 25,
          stackable: false,
          // bundled at SCALE (rows DB-4 and DB-5); never at STARTER, so rows DB-1..3 are unaffected
          includedAtPlan: "SCALE",
          grantsFlags: ["flag.forecasting", "flag.analytics"],
          meteredKey: null,
          capacityPerUnit: null,
        },
        {
          sku: "CUSTOMER_PACK_100",
          name: "Customer pack",
          monthlyPrice: 12,
          stackable: true,
          includedAtPlan: null,
          grantsFlags: [],
          meteredKey: "CUSTOMERS",
          capacityPerUnit: 100,
        },
      ],
    });

    function build() {
      const cat = catalog();
      const catalogService = {
        getPublishedCatalog: () => Promise.resolve(cat),
        getVersionForTenant: () => Promise.resolve(cat),
        getPublishedVersion: () => Promise.resolve(cat),
      } as any;
      const entitlements = {
        resolve: async () => ({
          planKey: "STARTER",
          planVersionId: versionId,
          flags: ["flag.msrp"],
          addons: [],
          status: "TRIAL",
        }),
        invalidate: jest.fn(),
      } as any;
      const preview = new FeaturePreviewService(
        entitlements,
        new FeatureOverrideService(prisma as any),
        catalogService,
        prisma as any,
        { getState: async () => ({ value: "unset", effective: "unset" }) } as any,
      );
      const svc = new SubscriptionMutationService(
        prisma as any,
        catalogService,
        new ProrationService(prisma as any, catalogService),
        { getSubscription: jest.fn().mockResolvedValue(undefined) } as any,
        entitlements,
        new BillingEventService(prisma as any),
        { invalidate: jest.fn() } as any,
        fakeStripeSubscription([]) as any,
        { notifyUpgradeConfirmed: jest.fn().mockResolvedValue(undefined) } as any,
        {
          prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
          onPlanChange: jest.fn().mockResolvedValue({ action: "none" }),
          transactionOptions: () => undefined,
          invalidateCaches: () => undefined,
        } as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          resolveAll: async () => null,
          assertFeatureRequiresMet: async () => undefined,
          invalidate: jest.fn(),
        } as any,
        preview,
      );
      return svc;
    }

    /** A TRIAL workspace with no subscription and no add-ons: the usual first pick on choose-plan. */
    async function trialTenant(tag: string): Promise<string> {
      seq += 1;
      const slug = assertTestTenant(
        `qa-target-plan-${tag}-${run}-${seq}`,
        "subscribe-target-plan.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({
        data: {
          slug,
          name: slug,
          class: TenantClass.PRODUCTION,
          status: TenantStatus.TRIAL,
          planVersionId: versionId,
          trialEndsAt: new Date(Date.now() + 7 * 86_400_000),
        },
      });
      tenantIds.push(tenant.id);
      return tenant.id;
    }

    const state = async (id: string) => ({
      tenant: await prisma.tenant.findUnique({
        where: { id },
        select: { status: true, plan: true },
      }),
      subscription: await prisma.tenantSubscription.count({ where: { tenantId: id } }),
      subPlanKey:
        (
          await prisma.tenantSubscription.findUnique({
            where: { tenantId: id },
            select: { planKey: true },
          })
        )?.planKey ?? null,
      rows: (await prisma.tenantAddon.findMany({ where: { tenantId: id } })).map((r) => ({
        sku: r.sku,
        active: r.active,
        price: Number(r.priceSnapshot ?? 0),
      })),
      events: await prisma.billingEvent.count({ where: { tenantId: id } }),
    });

    const pick = (sku: string) => ({
      planKey: "STARTER",
      cycle: "MONTHLY" as any,
      addons: [{ sku, quantity: 1 }],
    });

    it("DB-1: switch off, Starter with FORECASTING: a 409 ADDON_ALREADY_INCLUDED and nothing is written", async () => {
      delete process.env.PLAN_FLAG_ENFORCEMENT;
      const id = await trialTenant("off");
      const before = await state(id);
      await expect(build().subscribe(id, pick("FORECASTING"), "u1")).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: API_ERROR_CODES.ADDON_ALREADY_INCLUDED }),
      });
      expect(await state(id)).toEqual(before);
      expect(before.subscription).toBe(0);
      expect(before.rows).toEqual([]);
    });

    it("DB-2: switch on, no courtesy: the same pick sells - the plan moves and an active FORECASTING row is written at its price", async () => {
      process.env.PLAN_FLAG_ENFORCEMENT = "on";
      const id = await trialTenant("on");
      await build().subscribe(id, pick("FORECASTING"), "u1");
      const after = await state(id);
      expect(after.tenant).toMatchObject({ status: "ACTIVE", plan: "STARTER" });
      expect(after.subscription).toBe(1);
      expect(after.rows).toEqual([{ sku: "FORECASTING", active: true, price: 25 }]);
    });

    it("DB-3: switch off, the capacity SKU: sells - a capacity SKU is never 'already had'", async () => {
      delete process.env.PLAN_FLAG_ENFORCEMENT;
      const id = await trialTenant("pack");
      await build().subscribe(id, pick("CUSTOMER_PACK_100"), "u1");
      const after = await state(id);
      expect(after.tenant).toMatchObject({ status: "ACTIVE", plan: "STARTER" });
      expect(after.rows).toEqual([{ sku: "CUSTOMER_PACK_100", active: true, price: 12 }]);
    });

    /** An ACTIVE GROWTH / MONTHLY workspace, optionally holding an active FORECASTING row with no Stripe item. */
    async function activeGrowthTenant(tag: string, holdsForecasting: boolean): Promise<string> {
      seq += 1;
      const slug = assertTestTenant(
        `qa-target-plan-${tag}-${run}-${seq}`,
        "subscribe-target-plan.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({
        data: {
          slug,
          name: slug,
          class: TenantClass.PRODUCTION,
          status: TenantStatus.ACTIVE,
          planVersionId: versionId,
        },
      });
      tenantIds.push(tenant.id);
      await prisma.tenantSubscription.create({
        data: {
          tenantId: tenant.id,
          planKey: "GROWTH",
          planVersionId: versionId,
          basePriceSnapshot: 249,
          discount: 0,
          cycle: "MONTHLY",
          periodStart: new Date(Date.now() - 15 * 86_400_000),
          periodEnd: new Date(Date.now() + 15 * 86_400_000),
        },
      });
      if (holdsForecasting) {
        await prisma.tenantAddon.create({
          data: {
            tenantId: tenant.id,
            addonKey: "FORECASTING",
            sku: "FORECASTING",
            quantity: 1,
            priceSnapshot: 25,
            active: true,
          },
        });
      }
      return tenant.id;
    }

    // A cycle change is the one ACTIVE pick the B58 guard lets through subscribe().
    const toScale = {
      planKey: "SCALE",
      cycle: "ANNUAL" as any,
      addons: [{ sku: "FORECASTING", quantity: 1 }],
    };

    it("DB-4 (S6, SA-1099 A-5): the workspace holds an active FORECASTING row and SCALE bundles it: a keep - the plan moves and the row stays active", async () => {
      delete process.env.PLAN_FLAG_ENFORCEMENT;
      const id = await activeGrowthTenant("held", true);
      await build().subscribe(id, toScale, "u1");
      const after = await state(id);
      // (`Tenant.plan` is the legacy enum, where SCALE is BUSINESS; the subscription row carries the plan key)
      expect(after.tenant).toMatchObject({ status: "ACTIVE" });
      expect(after.subPlanKey).toBe("SCALE");
      // The row stays active (not refused, not dropped), and at $0: SCALE bundles it (SA-786/787). B1103 / SA-1104 Q5
      // (B-7): a SKU re-listed in `addons` used to be re-priced at the catalog price (25) by the reconcile.
      expect(after.rows).toEqual([{ sku: "FORECASTING", active: true, price: 0 }]);
    });

    /** The MRR ledger of one tenant: every event that moved the run-rate, and the net. */
    async function ledger(id: string) {
      const events = await prisma.billingEvent.findMany({
        where: { tenantId: id, amountDelta: { not: null } },
        orderBy: { createdAt: "asc" },
        select: { type: true, amountDelta: true },
      });
      const moves = events
        .map((e) => ({ type: e.type as string, delta: Number(e.amountDelta) }))
        .filter((e) => e.delta !== 0 && e.type !== BILLING_EVENTS.PLAN_CHANGED);
      return { moves, net: moves.reduce((s, e) => s + e.delta, 0) };
    }

    /** How many row-state records (ADDON_STATE_CHANGED) a tenant has: stopBilling writes one, a no-op write none. */
    const stateRecords = (id: string) =>
      prisma.billingEvent.count({
        where: { tenantId: id, type: BILLING_EVENTS.ADDON_STATE_CHANGED },
      });

    it("B-1 (B1103 / SA-1104): a held FORECASTING row that SCALE bundles, re-listed in addons: active, priceSnapshot 0, no Stripe item", async () => {
      delete process.env.PLAN_FLAG_ENFORCEMENT;
      const id = await activeGrowthTenant("b1", true);
      await build().subscribe(id, toScale, "u1");
      const row = await prisma.tenantAddon.findFirstOrThrow({ where: { tenantId: id } });
      expect({
        active: row.active,
        price: Number(row.priceSnapshot ?? 0),
        item: row.stripeItemId,
        isComp: row.isComp,
      }).toEqual({ active: true, price: 0, item: null, isComp: false });
    });

    it("B-2 (B1103 / SA-1104): the same pick books the run-rate ONCE: the stop (-25), no second event, one row record", async () => {
      delete process.env.PLAN_FLAG_ENFORCEMENT;
      const id = await activeGrowthTenant("b2", true);
      const recordsBefore = await stateRecords(id);
      await build().subscribe(id, toScale, "u1");
      const { moves, net } = await ledger(id);
      // the plan-change event is not an add-on move; exactly one add-on move exists: stopBilling's 25 -> 0
      expect(moves).toEqual([{ type: BILLING_EVENTS.ADDON_DISABLED, delta: -25 }]);
      expect(net).toBe(-25);
      // one record of the row's change (price 25 -> 0, written by stopBilling): the reconcile writes nothing more
      expect((await stateRecords(id)) - recordsBefore).toBe(1);
    });

    it("B-3 (guard): a SKU the target does NOT include, re-listed: the catalog price is kept and no add-on move is booked", async () => {
      delete process.env.PLAN_FLAG_ENFORCEMENT;
      const id = await activeGrowthTenant("b3", false);
      await prisma.tenantAddon.create({
        data: {
          tenantId: id,
          addonKey: "CUSTOMER_PACK_100",
          sku: "CUSTOMER_PACK_100",
          quantity: 1,
          priceSnapshot: 12,
          active: true,
        },
      });
      await build().subscribe(
        id,
        {
          planKey: "SCALE",
          cycle: "ANNUAL" as any,
          addons: [{ sku: "CUSTOMER_PACK_100", quantity: 1 }],
        },
        "u1",
      );
      const row = await prisma.tenantAddon.findFirstOrThrow({ where: { tenantId: id } });
      expect(Number(row.priceSnapshot)).toBe(12);
      expect((await ledger(id)).moves).toEqual([]);
    });

    it("B-4 (guard): a COMP row re-listed is left exactly as it is", async () => {
      delete process.env.PLAN_FLAG_ENFORCEMENT;
      const id = await activeGrowthTenant("b4", false);
      await prisma.tenantAddon.create({
        data: {
          tenantId: id,
          addonKey: "FORECASTING",
          sku: "FORECASTING",
          quantity: 1,
          priceSnapshot: 0,
          active: true,
          isComp: true,
        },
      });
      await build().subscribe(id, toScale, "u1");
      const row = await prisma.tenantAddon.findFirstOrThrow({ where: { tenantId: id } });
      expect({
        active: row.active,
        isComp: row.isComp,
        price: Number(row.priceSnapshot ?? 0),
      }).toEqual({
        active: true,
        isComp: true,
        price: 0,
      });
      expect((await ledger(id)).moves).toEqual([]);
    });

    it("B-5 (guard, #4214): an INACTIVE FORECASTING row re-listed on SCALE is a 409 ADDON_INCLUDED_IN_PLAN before any write", async () => {
      delete process.env.PLAN_FLAG_ENFORCEMENT;
      const id = await activeGrowthTenant("b5", false);
      await prisma.tenantAddon.create({
        data: {
          tenantId: id,
          addonKey: "FORECASTING",
          sku: "FORECASTING",
          quantity: 1,
          priceSnapshot: 25,
          active: false,
        },
      });
      const before = await state(id);
      await expect(build().subscribe(id, toScale, "u1")).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: API_ERROR_CODES.ADDON_INCLUDED_IN_PLAN }),
      });
      expect(await state(id)).toEqual(before);
    });

    it("B-8 (B1103, already included at the source): a SCALE workspace switching cycle re-lists the bundled row it holds at $0: it stays 0", async () => {
      delete process.env.PLAN_FLAG_ENFORCEMENT;
      const id = await activeGrowthTenant("b8", false);
      await prisma.tenantSubscription.update({
        where: { tenantId: id },
        data: { planKey: "SCALE", basePriceSnapshot: 499 },
      });
      await prisma.tenantAddon.create({
        data: {
          tenantId: id,
          addonKey: "FORECASTING",
          sku: "FORECASTING",
          quantity: 1,
          priceSnapshot: 0,
          active: true,
        },
      });
      await build().subscribe(id, toScale, "u1");
      const row = await prisma.tenantAddon.findFirstOrThrow({ where: { tenantId: id } });
      expect(Number(row.priceSnapshot ?? 0)).toBe(0);
      expect((await ledger(id)).moves).toEqual([]);
    });

    it("DB-5 (S7): the same pick with NO row: a 409 ADDON_INCLUDED_IN_PLAN and nothing is written", async () => {
      delete process.env.PLAN_FLAG_ENFORCEMENT;
      const id = await activeGrowthTenant("none", false);
      const before = await state(id);
      await expect(build().subscribe(id, toScale, "u1")).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: API_ERROR_CODES.ADDON_INCLUDED_IN_PLAN }),
      });
      expect(await state(id)).toEqual(before);
      expect(before.rows).toEqual([]);
    });
  },
);
