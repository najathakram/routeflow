/**
 * SA-733 D8 / B1103 / SA-786 — real Postgres. `upgrade()` stops billing every add-on the new plan includes inside
 * its own transaction: the row STAYS ACTIVE at $0 (the row is the entitlement), the MRR ledger books the add-on's
 * price to 0 EXACTLY ONCE (and the base
 * PLAN_CHANGED delta is untouched — Σ amountDelta equals the new run-rate), a comp row books nothing, and a
 * manual-pay tenant gets a STOP notice row. The mocked specs prove the call shapes; this proves the raw
 * `FOR UPDATE` row lock, the FK-backed writes and the notice row against the real tables.
 *
 * Real PrismaClient + BillingEventService; a stand-in catalog (the plan graph under test) that borrows a real
 * PlanVersion id for the FKs. Throwaway `qa-*` tenants (assertTestTenant). DB lane (F2). No Stripe: the
 * tenants carry no `stripeSubId`, so the push is skipped (its call shapes are the mocked specs' job).
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BillingEventService } from "./billing-event.service";
import { ProrationService } from "./proration.service";
import { AdminAuditAction } from "../platform-admin/audit-actions.constant";
import { fakeStripeSubscription } from "../testing/fake-stripe-subscription";
import { AddonService } from "./addon.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "B1103 / SA-786 upgrade() stops billing the add-ons the new plan includes and keeps them on (real Postgres)",
  () => {
    let pool: Pool;
    let prisma: PrismaClient;
    let mutation: SubscriptionMutationService;
    let buildMutation: (stripe: any) => SubscriptionMutationService;
    const tenantIds: string[] = [];
    const run = randomUUID().slice(0, 8);
    let versionId: string;
    let createdVersionId: string | undefined;

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
            notes: "qa fixture — created by plan-change-addon-retirement.db.spec.ts",
          },
        });
        createdVersionId = versionId = created.id;
      }
      // The plan graph under test: FORECASTING is bundled at SCALE and above.
      const catalog = {
        id: versionId,
        definitions: [
          {
            planKey: "GROWTH",
            name: "Growth",
            monthlyPrice: 249,
            annualPrice: null,
            isCustom: false,
          },
          {
            planKey: "SCALE",
            name: "Scale",
            monthlyPrice: 499,
            annualPrice: null,
            isCustom: false,
          },
        ],
        addonSkus: [
          { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 25, includedAtPlan: "SCALE" },
          {
            sku: "CUSTOMER_PACK_100",
            name: "Customer pack",
            monthlyPrice: 12,
            includedAtPlan: null,
          },
          // The admin-only regulated add-on, held under its LEGACY key (`tobacco_dealer`, sku null): R2.
          {
            sku: "REGULATED_ITEMS",
            name: "Regulated items",
            monthlyPrice: 39,
            includedAtPlan: "SCALE",
          },
        ],
      };
      const catalogService = {
        getPublishedCatalog: () => Promise.resolve(catalog),
        getVersionForTenant: () => Promise.resolve(catalog),
      } as any;
      buildMutation = (stripe: any) =>
        new SubscriptionMutationService(
          prisma as any,
          catalogService,
          new ProrationService(prisma as any, catalogService),
          { getSubscription: jest.fn().mockResolvedValue(undefined) } as any,
          { invalidate: jest.fn() } as any,
          new BillingEventService(prisma as any),
          { invalidate: jest.fn() } as any,
          stripe,
          { notifyUpgradeConfirmed: jest.fn().mockResolvedValue(undefined) } as any,
          {
            prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
            onPlanChange: () => Promise.resolve({ action: "none" }),
            transactionOptions: () => undefined,
            invalidateCaches: () => undefined,
          } as any,
        );
      mutation = buildMutation({}); // no stripeSubId on these tenants — nothing to push
    });

    afterAll(async () => {
      if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      if (createdVersionId) await prisma.planVersion.delete({ where: { id: createdVersionId } });
      await prisma.$disconnect();
      await pool.end();
    });

    async function tenantOnGrowth(
      tag: string,
      externalPayment = false,
      sub: {
        planKey?: string | null;
        stripeSubId?: string;
        basePriceSnapshot?: number | null;
      } = {},
    ): Promise<string> {
      const slug = assertTestTenant(
        `qa-b1103-${tag}-${run}`,
        "plan-change-addon-retirement.db.spec.ts",
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
          planKey: sub.planKey === undefined ? "GROWTH" : sub.planKey,
          planVersionId: versionId,
          basePriceSnapshot: sub.basePriceSnapshot === undefined ? 249 : sub.basePriceSnapshot,
          stripeSubId: sub.stripeSubId,
          discount: 0,
          cycle: "MONTHLY",
          periodStart: new Date(Date.now() - 15 * 86_400_000),
          periodEnd: new Date(Date.now() + 15 * 86_400_000),
          externalPayment,
        },
      });
      return tenant.id;
    }

    const addon = (tenantId: string, sku: string, over: Record<string, unknown> = {}) =>
      prisma.tenantAddon.create({
        data: {
          tenantId,
          addonKey: sku,
          sku,
          quantity: 1,
          priceSnapshot: 25,
          active: true,
          ...over,
        },
      });

    const deltas = async (tenantId: string) =>
      (
        await prisma.billingEvent.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } })
      ).map((e) => ({ type: e.type, delta: Number(e.amountDelta ?? 0) }));

    it("GROWTH + FORECASTING -> SCALE: the add-on row stays active at $0 and its price books to 0 once; the other add-on is untouched", async () => {
      const id = await tenantOnGrowth("billed");
      await addon(id, "FORECASTING");
      await addon(id, "CUSTOMER_PACK_100", { priceSnapshot: 12 });

      await mutation.upgrade(id, "SCALE", "admin-b1103");

      const rows = await prisma.tenantAddon.findMany({
        where: { tenantId: id },
        orderBy: { sku: "asc" },
      });
      expect(rows.map((r) => [r.sku, r.active, Number(r.priceSnapshot)])).toEqual([
        ["CUSTOMER_PACK_100", true, 12],
        ["FORECASTING", true, 0], // SA-786: stays ON, billing cleared
      ]);
      const ev = await deltas(id);
      expect(ev.filter((e) => e.type === "addon.disabled")).toEqual([
        { type: "addon.disabled", delta: -25 },
      ]);
      expect(ev.filter((e) => e.type === "plan.changed")).toEqual([
        { type: "plan.changed", delta: 250 },
      ]);
      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
      expect([sub.planKey, Number(sub.basePriceSnapshot)]).toEqual(["SCALE", 499]);
    }, 30_000);

    it("a COMP add-on stays active with no ledger delta", async () => {
      const id = await tenantOnGrowth("comp");
      // A STALE snapshot > 0 on purpose: only the isComp skip keeps the ledger clean.
      await addon(id, "FORECASTING", { isComp: true, priceSnapshot: 25 });

      await mutation.upgrade(id, "SCALE", "admin-b1103");

      const row = await prisma.tenantAddon.findFirstOrThrow({ where: { tenantId: id } });
      expect(row.active).toBe(true);
      expect((await deltas(id)).filter((e) => e.type === "addon.disabled")).toEqual([]);
    }, 30_000);

    it("a manual-pay tenant gets exactly one STOP notice row for the stopped, priced add-on", async () => {
      const id = await tenantOnGrowth("manual", true);
      await addon(id, "FORECASTING");

      await mutation.upgrade(id, "SCALE", "admin-b1103");

      const notices = await prisma.auditLog.findMany({
        where: { tenantId: id, action: AdminAuditAction.ADDON_MANUAL_INVOICE_STOP },
      });
      expect(notices).toHaveLength(1);
      expect(notices[0].meta).toMatchObject({ sku: "FORECASTING", kind: "stop", monthlyPrice: 25 });
    }, 30_000);

    it("R2: a LEGACY-keyed `tobacco_dealer` row (sku null, priced, manual-pay) keeps its ACCESS through GROWTH -> SCALE; the STOP notice is written once and the ledger books -price once", async () => {
      const id = await tenantOnGrowth("legacy", true);
      await prisma.tenantAddon.create({
        data: {
          tenantId: id,
          addonKey: "tobacco_dealer",
          sku: null,
          quantity: 1,
          priceSnapshot: 39,
          active: true,
        },
      });
      const addons = new AddonService(
        prisma as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        new BillingEventService(prisma as any),
        {} as any,
      );
      expect(await addons.getActiveAddons(id, { onlyKeys: ["tobacco_dealer"] })).toEqual([
        "tobacco_dealer",
      ]);

      await mutation.upgrade(id, "SCALE", "admin-sa786");

      // Master: the row went inactive, so this read was [] and the regulated gate answered 403.
      expect(await addons.getActiveAddons(id, { onlyKeys: ["tobacco_dealer"] })).toEqual([
        "tobacco_dealer",
      ]);
      const row = await prisma.tenantAddon.findFirstOrThrow({ where: { tenantId: id } });
      expect([row.active, Number(row.priceSnapshot), row.stripeItemId]).toEqual([true, 0, null]);
      const notices = await prisma.auditLog.findMany({
        where: { tenantId: id, action: AdminAuditAction.ADDON_MANUAL_INVOICE_STOP },
      });
      expect(notices).toHaveLength(1);
      expect(notices[0].meta).toMatchObject({
        sku: "REGULATED_ITEMS",
        kind: "stop",
        monthlyPrice: 39,
      });
      expect((await deltas(id)).filter((e) => e.type === "addon.disabled")).toEqual([
        { type: "addon.disabled", delta: -39 },
      ]);
    }, 30_000);

    it("S2: a planKey-NULL (manual-activation) ACTIVE tenant books NOTHING for the stopped add-on — its +price never reached the ledger", async () => {
      const id = await tenantOnGrowth("nullplan", false, {
        planKey: null,
        basePriceSnapshot: null,
      });
      await addon(id, "FORECASTING");

      await mutation.upgrade(id, "SCALE", "admin-b1103");

      const row = await prisma.tenantAddon.findFirstOrThrow({ where: { tenantId: id } });
      expect(row.active).toBe(true);
      const ev = await deltas(id);
      expect(ev.filter((e) => e.type === "addon.disabled")).toEqual([]);
      expect(ev.filter((e) => e.type === "plan.changed")).toEqual([
        { type: "plan.changed", delta: 499 },
      ]);
    }, 30_000);

    it("a double-clicked upgrade on a Stripe tenant serialises on the REAL tenant-price lock: one push, no revert, Stripe == the database", async () => {
      const stripe = fakeStripeSubscription([
        {
          id: "si_base",
          quantity: 1,
          price: {
            unit_amount: 24900,
            currency: "usd",
            recurring: { interval: "month" },
            product: "prod_growth",
          },
        },
      ]);
      const id = await tenantOnGrowth("dbl", false, { stripeSubId: `sub_dbl_${run}` });
      const svc = buildMutation(stripe);

      const results = await Promise.allSettled([
        svc.upgrade(id, "SCALE", "admin-b1103"),
        svc.upgrade(id, "SCALE", "admin-b1103"),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(stripe.updateSubscription).toHaveBeenCalledTimes(1); // the loser never pushed, so nothing to revert
      expect(stripe.amountOf("si_base")).toBe(49900);
      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
      expect([sub.planKey, Number(sub.basePriceSnapshot)]).toEqual(["SCALE", 499]);
      expect((await deltas(id)).filter((e) => e.type === "plan.changed")).toHaveLength(1);
    }, 30_000);
  },
);
