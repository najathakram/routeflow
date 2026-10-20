/**
 * Train merge guard (BO-13 + SA-786/787) — real Postgres. ONE `subscribe()` call that carries BOTH
 *   (a) a PENDING add-on in `addons[]` that the checkout activates (CUSTOMER_PACK_100, self-serve), and
 *   (b) an existing ACTIVE billed add-on row the TARGET plan INCLUDES (REGULATED_ITEMS, bundled at SCALE).
 *
 * The two changes sit on adjacent lines in subscribe(): BO-13 hands the plan-change hook
 * `pendingAddonKeys` (the rows this checkout activates are written AFTER the hook), and SA-786/787 stops
 * billing the included row (stays ON at $0) before the plan write. This spec proves they compose:
 *   - the hook is told the pending SKU; the pending row is created active at its catalog price and booked ONCE;
 *   - the included row stays active at $0, its price books to 0 once, nothing is pushed to Stripe;
 *   - the ledger holds exactly plan.changed + addon.disabled + addon.enabled (no double booking);
 *   - a stored Stripe subscription that still holds the included row's item makes subscribe() refuse (409,
 *     `noPushCtx` semantics) with NOTHING written - no plan move, no pending row, no event, no Stripe call.
 *
 * Real PrismaClient + BillingEventService + ProrationService + SubscriptionMutationService; a stand-in catalog
 * (the plan graph under test) borrowing a real PlanVersion id for the FKs; a stateful fake Stripe. Throwaway
 * `qa-*` tenants (assertTestTenant). The tenant is ACTIVE on GROWTH MONTHLY and picks SCALE ANNUAL: a cycle
 * change is the one ACTIVE pick the B58 guard lets through subscribe() (a same-cycle pick goes to upgrade()).
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BillingEventService } from "./billing-event.service";
import { ProrationService } from "./proration.service";
import { fakeStripeSubscription } from "../testing/fake-stripe-subscription";
import { PLAN_CHANGE_ADDONS_CHANGED } from "./plan-change-stripe";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "BO-13 + SA-786 subscribe() with a pending add-on and an included add-on together (real Postgres)",
  () => {
    let pool: Pool;
    let prisma: PrismaClient;
    let versionId: string;
    let createdVersionId: string | undefined;
    const tenantIds: string[] = [];
    const run = randomUUID().slice(0, 8);
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
            notes: "qa fixture — created by subscribe-pending-and-included.db.spec.ts",
          },
        });
        createdVersionId = versionId = created.id;
      }
    });

    afterAll(async () => {
      if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      if (createdVersionId) await prisma.planVersion.delete({ where: { id: createdVersionId } });
      await prisma.$disconnect();
      await pool.end();
    });

    /** The plan graph under test: REGULATED_ITEMS is bundled at SCALE; CUSTOMER_PACK_100 never is. */
    const catalog = () => ({
      id: versionId,
      definitions: [
        {
          planKey: "GROWTH",
          name: "Growth",
          monthlyPrice: 249,
          annualPrice: null,
          isCustom: false,
        },
        { planKey: "SCALE", name: "Scale", monthlyPrice: 499, annualPrice: null, isCustom: false },
      ],
      addonSkus: [
        {
          sku: "CUSTOMER_PACK_100",
          name: "Customer pack",
          monthlyPrice: 12,
          includedAtPlan: null,
        },
        {
          sku: "REGULATED_ITEMS",
          name: "Regulated items",
          monthlyPrice: 39,
          includedAtPlan: "SCALE",
        },
      ],
    });

    function build(stripe: any) {
      const cat = catalog();
      const catalogService = {
        getPublishedCatalog: () => Promise.resolve(cat),
        getVersionForTenant: () => Promise.resolve(cat),
      } as any;
      const onPlanChange = jest.fn().mockResolvedValue({ action: "none" });
      const svc = new SubscriptionMutationService(
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
          onPlanChange,
          transactionOptions: () => undefined,
          invalidateCaches: () => undefined,
        } as any,
      );
      return { svc, onPlanChange };
    }

    /** An ACTIVE GROWTH / MONTHLY tenant holding a billed REGULATED_ITEMS row (optionally with a Stripe item). */
    async function activeTenantWithIncludedRow(
      tag: string,
      stripe?: { subId: string; itemId: string },
    ): Promise<string> {
      seq += 1;
      const slug = assertTestTenant(
        `qa-pending-incl-${tag}-${run}-${seq}`,
        "subscribe-pending-and-included.db.spec.ts",
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
          stripeSubId: stripe?.subId,
          discount: 0,
          cycle: "MONTHLY",
          periodStart: new Date(Date.now() - 15 * 86_400_000),
          periodEnd: new Date(Date.now() + 15 * 86_400_000),
        },
      });
      await prisma.tenantAddon.create({
        data: {
          tenantId: tenant.id,
          addonKey: "REGULATED_ITEMS",
          sku: "REGULATED_ITEMS",
          quantity: 1,
          priceSnapshot: 39,
          active: true,
          stripeItemId: stripe?.itemId,
        },
      });
      return tenant.id;
    }

    const events = async (tenantId: string) =>
      (
        await prisma.billingEvent.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } })
      ).map((e) => ({
        type: e.type,
        sku: (e.payload as { sku?: string } | null)?.sku ?? null,
        delta: Number(e.amountDelta ?? 0),
      }));

    const rowsOf = async (tenantId: string) =>
      (
        await prisma.tenantAddon.findMany({ where: { tenantId }, orderBy: { addonKey: "asc" } })
      ).map((r) => ({
        sku: r.sku,
        active: r.active,
        price: Number(r.priceSnapshot ?? 0),
        qty: r.quantity,
        comp: r.isComp,
        item: r.stripeItemId,
      }));

    const PICK = {
      planKey: "SCALE",
      cycle: "ANNUAL" as any,
      addons: [{ sku: "CUSTOMER_PACK_100", quantity: 1 }],
    };

    it("one subscribe(): the pending add-on is created at its catalog price and booked once; the included row stays ON at $0; the hook is told the pending SKU; nothing is pushed to Stripe", async () => {
      const stripe = fakeStripeSubscription([]);
      const { svc, onPlanChange } = build(stripe);
      const id = await activeTenantWithIncludedRow("happy");

      await svc.subscribe(id, PICK, "tenant-user-1");

      // BO-13: the hook judged the END state - it was told which add-on this checkout activates.
      expect(onPlanChange).toHaveBeenCalledTimes(1);
      expect(onPlanChange.mock.calls[0][1]).toMatchObject({
        tenantId: id,
        fromPlanKey: "GROWTH",
        toPlanKey: "SCALE",
        pendingAddonKeys: ["CUSTOMER_PACK_100"],
      });

      expect(await rowsOf(id)).toEqual([
        { sku: "CUSTOMER_PACK_100", active: true, price: 12, qty: 1, comp: false, item: null },
        { sku: "REGULATED_ITEMS", active: true, price: 0, qty: 1, comp: false, item: null }, // SA-786
      ]);

      // Exactly the expected ledger: the plan delta, the included row's price to 0 once, the pending row once.
      const ev = await events(id);
      expect(ev.filter((e) => e.type === "plan.changed")).toEqual([
        { type: "plan.changed", sku: null, delta: 250 },
      ]);
      expect(ev.filter((e) => e.type === "addon.disabled")).toEqual([
        { type: "addon.disabled", sku: "REGULATED_ITEMS", delta: -39 },
      ]);
      expect(ev.filter((e) => e.type === "addon.enabled")).toEqual([
        { type: "addon.enabled", sku: "CUSTOMER_PACK_100", delta: 12 },
      ]);
      // addon.state_changed (SA-788) is the delta-0 change record - one per row written, never a money event.
      expect(ev.filter((e) => e.type === "addon.state_changed")).toEqual([
        { type: "addon.state_changed", sku: "REGULATED_ITEMS", delta: 0 },
        { type: "addon.state_changed", sku: "CUSTOMER_PACK_100", delta: 0 },
      ]);
      expect(ev.filter((e) => e.delta !== 0)).toHaveLength(3); // no double booking
      expect(ev.reduce((s, e) => s + e.delta, 0)).toBe(223); // 250 - 39 + 12

      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
      expect([sub.planKey, sub.cycle, Number(sub.basePriceSnapshot)]).toEqual([
        "SCALE",
        "ANNUAL",
        499,
      ]);
      expect(stripe.updateSubscription).not.toHaveBeenCalled();
      expect(stripe.state.items).toEqual([]); // no item created, none orphaned
    }, 30_000);

    it("a replayed identical subscribe() is refused (B58 - now ACTIVE, same cycle) and books nothing a second time", async () => {
      const stripe = fakeStripeSubscription([]);
      const { svc } = build(stripe);
      const id = await activeTenantWithIncludedRow("replay");
      await svc.subscribe(id, PICK, "tenant-user-1");
      const before = await events(id);

      await expect(svc.subscribe(id, PICK, "tenant-user-1")).rejects.toMatchObject({ status: 409 });

      expect(await events(id)).toEqual(before);
      expect(await rowsOf(id)).toEqual([
        { sku: "CUSTOMER_PACK_100", active: true, price: 12, qty: 1, comp: false, item: null },
        { sku: "REGULATED_ITEMS", active: true, price: 0, qty: 1, comp: false, item: null },
      ]);
    }, 30_000);

    it("a stored Stripe subscription still holding the included row's item: 409 (noPushCtx) with NOTHING written - no plan move, no pending row, no event, no Stripe call", async () => {
      const stripe = fakeStripeSubscription([
        {
          id: "si_qa_regulated",
          quantity: 1,
          price: {
            unit_amount: 3900,
            currency: "usd",
            recurring: { interval: "month" },
            product: "prod_regulated",
          },
        },
      ]);
      const { svc, onPlanChange } = build(stripe);
      const id = await activeTenantWithIncludedRow("stripe", {
        subId: `sub_qa_${run}`,
        itemId: "si_qa_regulated",
      });

      await expect(svc.subscribe(id, PICK, "tenant-user-1")).rejects.toMatchObject({
        status: 409,
        message: PLAN_CHANGE_ADDONS_CHANGED,
      });

      // The hook ran inside the rolled-back transaction, and was still told the pending SKU.
      expect(onPlanChange).toHaveBeenCalledTimes(1);
      expect(onPlanChange.mock.calls[0][1].pendingAddonKeys).toEqual(["CUSTOMER_PACK_100"]);

      // Nothing written: the pending row never appeared, the included row keeps its price AND its item.
      expect(await rowsOf(id)).toEqual([
        {
          sku: "REGULATED_ITEMS",
          active: true,
          price: 39,
          qty: 1,
          comp: false,
          item: "si_qa_regulated",
        },
      ]);
      expect(await events(id)).toEqual([]);
      const sub = await prisma.tenantSubscription.findUniqueOrThrow({ where: { tenantId: id } });
      expect([sub.planKey, sub.cycle, Number(sub.basePriceSnapshot)]).toEqual([
        "GROWTH",
        "MONTHLY",
        249,
      ]);
      expect(stripe.updateSubscription).not.toHaveBeenCalled();
      expect(stripe.state.items.map((i) => i.id)).toEqual(["si_qa_regulated"]); // not orphaned, not removed
    }, 30_000);
  },
);
