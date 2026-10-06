/**
 * DB-lane spec for the B864/B865 activation-ledger gap — SA-277/277a (ruling at
 * `.claude/pipeline/2026-09-25-f51-billing-mrr-ledger/cause-ruling.md`), against real Postgres.
 *
 * REG-B864-DB: `PlatformAdminService.updateTenantPriceOverride()` back-fills a null
 * `basePriceSnapshot` the moment a negotiated fee is entered, but only EMITS the compensating
 * `plan.changed` delta when the tenant is currently in `MrrService`'s paying set
 * (`isPayingRow` — ACTIVE + PRODUCTION + a resolved planKey). A TRIAL tenant is not paying, so
 * the snapshot write lands with zero ledger rows. `activateManualSubscription()` then flips the
 * tenant ACTIVE and crosses the paying-set boundary itself, so IT books the one delta — priced
 * off the snapshot the price-override call already wrote. The two calls must never both book
 * the $1200: one write, one price, one event.
 *
 * REG-B864-DB-RACE: the tenant-row `FOR UPDATE` lock both methods take first (SA-163 shape)
 * serialises a concurrent `updateTenantPriceOverride` + `activateManualSubscription` pair no
 * matter which one wins the race — the ledger sum lands on the same $1200 either way (see the
 * per-branch reasoning in this file's test body).
 *
 * REG-B865-DB: `SubscriptionMutationService.enableAddon()` books through the shared
 * `emitAddonDelta` ledger writer (`addon-ledger.ts`), which gates its own emit on the same
 * `isPayingRow` check — a TRIAL tenant's self-serve add-on writes the `TenantAddon` row but books
 * nothing. Since #3129 (SA-690) that row is UNBILLED: `priceSnapshot` 0.00, so the activation
 * CROSSING books the base in one `plan.changed` row through the helper `subscribe()` uses
 * (SA-277b) and nothing for the add-on. A MANUAL activation then prices that row at today's
 * catalog price and books its delta ONCE as one `addon.enabled` row (SA-668c residual,
 * `priceUnbilledAddonsOnActivation`) — base + add-on, each exactly once.
 *
 * SA-668c / M-A: that pricing happens on the TRIAL -> ACTIVE crossing ONLY. A renewal of an already
 * ACTIVE manual tenant prices nothing, books nothing and writes no notice; a row that cannot be
 * priced (no catalog price, no quantity) is announced, never silently priced; an ANNUAL tenant's
 * notice carries the cycle and the per-cycle amount (MRR stays monthly); a non-PRODUCTION tenant
 * is never announced; concurrent activations book and announce once.
 *
 * `PlatformAdminService` and `SubscriptionMutationService` are constructed directly (bypassing
 * Nest DI) with REAL `PrismaService`/`BillingEventService`/`MrrService`/`PlanCatalogService`/
 * `ProrationService` (every collaborator the exercised methods actually touch) and lightweight
 * stand-ins for the rest, mirroring `update-tenant-class-ledger.db.spec.ts`. This spec calls
 * ONLY the public service methods (`updateTenantPriceOverride`, `activateManualSubscription`,
 * `enableAddon`) — never the `addon-ledger.ts` helper directly — so it stays correct whether
 * that helper's internal contract is priceSnapshot/deltaQty or before/after.
 *
 * `dto.plan` activates onto "STARTER" ($59) with the CUSTOMER_PACK_100 add-on. The spec reuses a
 * PUBLISHED catalog when one exists; on a fresh database it provisions a minimal one and removes
 * it in afterAll (never touching a pre-existing catalog).
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
import { MrrService } from "../billing/mrr.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { ProrationService } from "../billing/proration.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "PlatformAdminService/SubscriptionMutationService — activation ledger, real Postgres (B864/B865)",
  () => {
    let pool: Pool;
    let prisma: PrismaClient;
    let platformAdmin: PlatformAdminService;
    /** A PlatformAdminService over the same real collaborators, with its own plan-catalog reader. */
    let makeAdmin: (catalogReader: any) => PlatformAdminService;
    let subscriptionMutation: SubscriptionMutationService;
    const tenantIds: string[] = [];
    const run = randomUUID().slice(0, 8);

    // Flag permanently off: activateManualSubscription/updateTenantPriceOverride read it before
    // opening their own transaction, so this stand-in never has to model the config-snapshot
    // hook itself — every site behaves exactly as if the hook were never wired.
    const planTransitionStub = {
      isEnabled: () => Promise.resolve(false),
      prepare: () => Promise.resolve({ enabled: false, planAllows: null }),
      onPlanChange: () => Promise.resolve({ action: "none" }),
      transactionOptions: () => undefined,
      invalidateCaches: () => undefined,
    } as any;

    // Set only when this spec created the catalog itself (no PUBLISHED PlanVersion existed) —
    // afterAll deletes exactly this version's rows and nothing else.
    let createdVersionId: string | undefined;
    // STARTER's monthly price in the catalog actually in play (self-provisioned or pre-existing).
    let starterPrice: number;

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      // Self-provision the catalog on a fresh database (same pattern as
      // backfill-subscription-reconciliation.db.spec.ts): reuse a PUBLISHED PlanVersion when one
      // exists (compose DB after `local:seed`), otherwise create the minimum this spec needs.
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
            notes: "qa fixture — created by override-activation-ledger.db.spec.ts",
            definitions: {
              create: [
                {
                  planKey: "STARTER",
                  name: "Starter",
                  monthlyPrice: 59,
                  isCustom: false,
                  featureFlags: [],
                },
              ],
            },
            addonSkus: {
              create: [
                {
                  sku: "CUSTOMER_PACK_100",
                  name: "Customer pack 100",
                  monthlyPrice: 25,
                  grantsFlags: [],
                },
                {
                  sku: "FORECASTING",
                  name: "Forecasting",
                  monthlyPrice: 19,
                  grantsFlags: [],
                },
              ],
            },
          },
        });
        createdVersionId = created.id;
      }

      const inPlay = await prisma.planVersion.findFirstOrThrow({
        where: { status: "PUBLISHED" },
        include: { definitions: { where: { planKey: "STARTER" } } },
      });
      starterPrice = Number(inPlay.definitions[0].monthlyPrice);
      expect(starterPrice).toBeGreaterThan(0);

      const noop = {} as any;
      const catalog = new PlanCatalogService(prisma as any);
      const events = new BillingEventService(prisma as any);
      const mrr = new MrrService(prisma as any);

      makeAdmin = (catalogReader: any) =>
        new PlatformAdminService(
          prisma as any,
          noop, // jwtService — unused by the methods this spec exercises
          noop, // config
          noop, // emailService
          { syncStripeSubscriptionPrice: jest.fn().mockResolvedValue(undefined) } as any, // billingService
          { resolveTenantPricing: jest.fn().mockResolvedValue({}) } as any, // platformPricingService
          catalogReader,
          noop, // proration — unused by these two methods
          noop, // entitlementsService
          events,
          noop, // meterService
          { invalidate: jest.fn() } as any, // tenantStatusGuard
          { log: jest.fn().mockResolvedValue(undefined) } as any, // auditService — recordAdminAction()
          mrr,
          noop, // tenantMirror
          noop, // featureOverrides
          planTransitionStub,
        );
      platformAdmin = makeAdmin(catalog);

      subscriptionMutation = new SubscriptionMutationService(
        prisma as any,
        catalog,
        new ProrationService(prisma as any, catalog),
        { getSubscription: jest.fn().mockResolvedValue(undefined) } as any, // subscription
        { invalidate: jest.fn() } as any, // entitlementsService
        events,
        noop, // tenantStatus — unused by enableAddon
        noop, // stripe — unused by enableAddon
        noop, // billingNotification — unused by enableAddon
        planTransitionStub,
      );
    });

    afterAll(async () => {
      if (tenantIds.length) {
        await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      }
      if (createdVersionId) {
        await prisma.addonSku.deleteMany({ where: { planVersionId: createdVersionId } });
        await prisma.planDefinition.deleteMany({ where: { planVersionId: createdVersionId } });
        await prisma.planVersion.delete({ where: { id: createdVersionId } });
      }
      await prisma.$disconnect();
      await pool.end();
    });

    async function ledgerSum(tenantId: string): Promise<number> {
      const rows = await prisma.billingEvent.findMany({
        where: { tenantId },
        select: { amountDelta: true },
      });
      return rows.reduce((s, r) => s + (r.amountDelta != null ? Number(r.amountDelta) : 0), 0);
    }

    async function makeTrialTenant(
      slugPrefix: string,
      planKey: string,
      cls: TenantClass = TenantClass.PRODUCTION,
    ): Promise<string> {
      const slug = assertTestTenant(
        `qa-${slugPrefix}-${run}`,
        "override-activation-ledger.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({
        data: { slug, name: slug, class: cls, status: TenantStatus.TRIAL },
      });
      tenantIds.push(tenant.id);
      await prisma.tenantSubscription.create({
        data: { tenantId: tenant.id, planKey, basePriceSnapshot: null, discount: 0 },
      });
      return tenant.id;
    }

    it("REG-B864-DB: price-override back-fill on a TRIAL tenant books zero events; a later manual activation books exactly one, at the snapshot value, with ANNUAL cycle", async () => {
      const tenantId = await makeTrialTenant("b864-seq", "GROWTH");

      await platformAdmin.updateTenantPriceOverride(tenantId, { monthly: 1200 } as any, "admin-1");

      const afterOverride = await prisma.tenantSubscription.findUniqueOrThrow({
        where: { tenantId },
        select: { basePriceSnapshot: true },
      });
      expect(Number(afterOverride.basePriceSnapshot)).toBe(1200);
      expect(await ledgerSum(tenantId)).toBe(0);

      await platformAdmin.activateManualSubscription(
        tenantId,
        {
          plan: "STARTER",
          paymentMethod: "ZELLE",
          paymentRef: "ref-1",
          billingPeriodDays: 365,
        } as any,
        "admin-1",
      );

      expect(await ledgerSum(tenantId)).toBe(1200); // never 2400 — booked exactly once

      const events = await prisma.billingEvent.findMany({
        where: { tenantId, type: "plan.changed" },
        select: { amountDelta: true },
      });
      expect(events).toHaveLength(1);
      expect(Number(events[0].amountDelta)).toBe(1200);

      const sub = await prisma.tenantSubscription.findUniqueOrThrow({
        where: { tenantId },
        select: { cycle: true },
      });
      expect(sub.cycle).toBe("ANNUAL");
    });

    it("REG-B864-DB-RACE: a concurrent price-override + manual activation on the same tenant serialise through the tenant row lock and book exactly $1200 total, never $0 or $2400", async () => {
      const tenantId = await makeTrialTenant("b864-race", "GROWTH");

      // Whichever of the two wins the tenant-row `FOR UPDATE` lock first fully commits before
      // the other proceeds (both take the lock as their first statement inside their own
      // transaction). If the price-override commits first, the activation reads the $1200
      // snapshot and books it. If the activation commits first (against the still-null
      // snapshot, contributing $0), the price-override's own backfill-gate re-reads the tenant
      // row UNDER its lock — now ACTIVE/paying — and books the $1200 itself. Either interleaving
      // nets to the same $1200; only the event that carries it differs.
      await Promise.all([
        platformAdmin.updateTenantPriceOverride(tenantId, { monthly: 1200 } as any, "admin-1"),
        platformAdmin.activateManualSubscription(
          tenantId,
          {
            plan: "STARTER",
            paymentMethod: "ZELLE",
            paymentRef: "ref-2",
            billingPeriodDays: 365,
          } as any,
          "admin-1",
        ),
      ]);

      expect(await ledgerSum(tenantId)).toBe(1200);
    });

    it("REG-B865-DB: a TRIAL tenant's unbilled self-serve add-on is priced 0 and books zero events; manual activation books the base once (plan.changed) and then prices the add-on and books its delta once (addon.enabled)", async () => {
      const tenantId = await makeTrialTenant("b865", "GROWTH");
      // This case's base is already known (unlike B864's null-snapshot shape) — the add-on
      // ledger gate is what's under test here, not the backfill path.
      await prisma.tenantSubscription.update({
        where: { tenantId },
        data: { basePriceSnapshot: starterPrice },
      });

      const preview = await subscriptionMutation.enableAddon(tenantId, "CUSTOMER_PACK_100", 1);
      expect(preview).toBeDefined();
      expect(await ledgerSum(tenantId)).toBe(0);

      const addon = await prisma.tenantAddon.findUniqueOrThrow({
        where: { tenantId_addonKey: { tenantId, addonKey: "CUSTOMER_PACK_100" } },
        select: { active: true, priceSnapshot: true, quantity: true },
      });
      expect(addon.active).toBe(true);
      // SA-690 / #3129: a trial/pilot add-on is UNBILLED — snapshot 0.00, never the catalog price.
      expect(Number(addon.priceSnapshot)).toBe(0);

      await platformAdmin.activateManualSubscription(
        tenantId,
        {
          plan: "STARTER",
          paymentMethod: "ZELLE",
          paymentRef: "ref-3",
          billingPeriodDays: 30,
        } as any,
        "admin-1",
      );

      // SA-668c residual: a MANUAL activation prices the trial's unbilled add-on at today's catalog
      // price (it would otherwise stay free forever on a hand-invoiced tenant) and books it ONCE.
      const packPrice = await catalogPrice("CUSTOMER_PACK_100");
      expect(await ledgerSum(tenantId)).toBe(starterPrice + packPrice);

      // SA-277b: the crossing helper books the base in its own plan.changed row; the add-on's own
      // delta follows as one addon.enabled row (the crossing saw it at 0 and booked nothing for it).
      const plan = await prisma.billingEvent.findMany({
        where: { tenantId, type: "plan.changed" },
        select: { amountDelta: true },
      });
      expect(plan).toHaveLength(1);
      expect(Number(plan[0].amountDelta)).toBe(starterPrice);
      const addonRows = await prisma.billingEvent.findMany({
        where: { tenantId, type: "addon.enabled" },
        select: { amountDelta: true },
      });
      expect(addonRows.map((r) => Number(r.amountDelta))).toEqual([packPrice]);
    });

    async function catalogPrice(sku: string): Promise<number> {
      const version = await new PlanCatalogService(prisma as any).getPublishedVersion();
      const def = version?.addonSkus.find((a) => a.sku === sku);
      if (!def) throw new Error(`the published catalog has no ${sku}`);
      return Number(def.monthlyPrice);
    }
    const activate = (tenantId: string, ref: string) =>
      platformAdmin.activateManualSubscription(
        tenantId,
        { plan: "STARTER", paymentMethod: "ZELLE", paymentRef: ref, billingPeriodDays: 30 } as any,
        "admin-1",
      );
    const addAddon = (
      tenantId: string,
      sku: string,
      quantity: number,
      extra: Record<string, unknown> = {},
    ) =>
      prisma.tenantAddon.create({
        data: { tenantId, addonKey: sku, sku, quantity, active: true, priceSnapshot: 0, ...extra },
      });
    const notices = (tenantId: string) =>
      prisma.auditLog.findMany({
        where: { tenantId, action: "ADDON_MANUAL_INVOICE_DUE" },
        orderBy: { createdAt: "asc" },
      });

    it("SA-668c: manual activation PRICES each unbilled self-serve add-on at today's catalog price, books each ONCE, writes one DUE notice each; a re-activation does nothing more", async () => {
      const tenantId = await makeTrialTenant("sa668c", "GROWTH");
      await prisma.tenantSubscription.update({
        where: { tenantId },
        data: { basePriceSnapshot: starterPrice },
      });
      await addAddon(tenantId, "CUSTOMER_PACK_100", 2);
      await addAddon(tenantId, "FORECASTING", 1);
      // SA-693: platform grants (comps) beside them are NEVER priced, booked or announced
      await addAddon(tenantId, "MSRP", 1, { isComp: true });
      await addAddon(tenantId, "SEAT_EXTRA", 4, { isComp: true });
      const pack = await catalogPrice("CUSTOMER_PACK_100");
      const forecasting = await catalogPrice("FORECASTING");

      await activate(tenantId, "ref-668c-1");

      const rows = await prisma.tenantAddon.findMany({
        where: { tenantId },
        orderBy: { sku: "asc" },
      });
      expect(
        rows.map((r) => [r.sku, Number(r.priceSnapshot), r.quantity, r.stripeItemId, r.isComp]),
      ).toEqual([
        ["CUSTOMER_PACK_100", pack, 2, null, false],
        ["FORECASTING", forecasting, 1, null, false],
        ["MSRP", 0, 1, null, true], // the comps are untouched
        ["SEAT_EXTRA", 0, 4, null, true],
      ]);
      // the base once (plan.changed), then one addon.enabled per row at price × quantity
      expect(await ledgerSum(tenantId)).toBe(starterPrice + pack * 2 + forecasting);
      const adds = await prisma.billingEvent.findMany({
        where: { tenantId, type: "addon.enabled" },
        orderBy: { createdAt: "asc" },
      });
      expect(adds.map((e) => Number(e.amountDelta)).sort()).toEqual([pack * 2, forecasting].sort());
      // one DUE notice per priced row, shaped as the manual enable path writes it
      const due = await notices(tenantId);
      expect(due).toHaveLength(2);
      const bySku = Object.fromEntries(due.map((n) => [(n.meta as any).sku, n.meta as any]));
      expect(bySku.CUSTOMER_PACK_100).toMatchObject({
        platformAdmin: true,
        kind: "add",
        quantity: 2,
        monthlyPrice: pack,
        fromQty: 0,
        toQty: 2,
        addonName: expect.any(String),
        message: expect.stringContaining("add to their next manual invoice"),
      });
      expect(bySku.FORECASTING).toMatchObject({
        kind: "add",
        quantity: 1,
        monthlyPrice: forecasting,
      });

      // IDEMPOTENT: a re-activation books nothing and writes no second notice
      const sumAfter = await ledgerSum(tenantId);
      const eventsAfter = await prisma.billingEvent.count({ where: { tenantId } });
      await activate(tenantId, "ref-668c-2");
      expect(await ledgerSum(tenantId)).toBe(sumAfter);
      expect(await prisma.billingEvent.count({ where: { tenantId } })).toBe(eventsAfter);
      expect(await notices(tenantId)).toHaveLength(2);
    });

    it("SA-693: a COMP of a self-serve SKU is never priced, booked or announced at manual activation — only the base books", async () => {
      const tenantId = await makeTrialTenant("sa668c-comp", "GROWTH");
      await prisma.tenantSubscription.update({
        where: { tenantId },
        data: { basePriceSnapshot: starterPrice },
      });
      await addAddon(tenantId, "CUSTOMER_PACK_100", 2, { isComp: true });
      await addAddon(tenantId, "FORECASTING", 1, { isComp: true });

      await activate(tenantId, "ref-668c-comp");

      const rows = await prisma.tenantAddon.findMany({
        where: { tenantId },
        orderBy: { sku: "asc" },
      });
      expect(rows.map((r) => [r.sku, Number(r.priceSnapshot), r.isComp])).toEqual([
        ["CUSTOMER_PACK_100", 0, true],
        ["FORECASTING", 0, true],
      ]);
      expect(await ledgerSum(tenantId)).toBe(starterPrice);
      expect(await notices(tenantId)).toHaveLength(0);
    });

    it("SA-668c: a Stripe-billed row and an already-priced row are left alone; only the unbilled, unpriced one is priced", async () => {
      const tenantId = await makeTrialTenant("sa668c-b", "GROWTH");
      await prisma.tenantSubscription.update({
        where: { tenantId },
        data: { basePriceSnapshot: starterPrice },
      });
      await addAddon(tenantId, "CUSTOMER_PACK_100", 3, {
        stripeItemId: "si_billed",
        priceSnapshot: 11,
      });
      await addAddon(tenantId, "FORECASTING", 1);
      const forecasting = await catalogPrice("FORECASTING");

      await activate(tenantId, "ref-668c-3");

      const rows = await prisma.tenantAddon.findMany({
        where: { tenantId },
        orderBy: { sku: "asc" },
      });
      expect(rows.map((r) => [r.sku, Number(r.priceSnapshot), r.stripeItemId])).toEqual([
        ["CUSTOMER_PACK_100", 11, "si_billed"], // untouched
        ["FORECASTING", forecasting, null],
      ]);
      // the billed row's contribution is the crossing's (stored 11 × 3, booked by the crossing helper);
      // only the unbilled row gets a DUE notice and its own addon.enabled delta
      expect((await notices(tenantId)).map((n) => (n.meta as any).sku)).toEqual(["FORECASTING"]);
      const amounts = (
        await prisma.billingEvent.findMany({ where: { tenantId, type: "addon.enabled" } })
      ).map((e) => Number(e.amountDelta));
      expect(amounts.sort((x, y) => x - y)).toEqual([33, forecasting].sort((x, y) => x - y));
      expect(await ledgerSum(tenantId)).toBe(starterPrice + 33 + forecasting);
    });

    const activateOn = (admin: PlatformAdminService, tenantId: string, ref: string, days = 30) =>
      admin.activateManualSubscription(
        tenantId,
        {
          plan: "STARTER",
          paymentMethod: "ZELLE",
          paymentRef: ref,
          billingPeriodDays: days,
        } as any,
        "admin-1",
      );
    const events = (tenantId: string, type: string) =>
      prisma.billingEvent.findMany({ where: { tenantId, type }, orderBy: { createdAt: "asc" } });
    /** The catalog as the owner left it: CUSTOMER_PACK_100 gone, FORECASTING free. */
    const catalogWithNoUsablePrices = () => {
      const real = new PlanCatalogService(prisma as any);
      const reader = Object.create(real);
      reader.getPublishedVersion = async () => {
        const v = (await real.getPublishedVersion()) as any;
        return {
          ...v,
          addonSkus: v.addonSkus
            .filter((a: any) => a.sku !== "CUSTOMER_PACK_100")
            .map((a: any) => (a.sku === "FORECASTING" ? { ...a, monthlyPrice: 0 } : a)),
        };
      };
      return reader;
    };

    it("S3: a TRIAL row that already carries a price but has no Stripe item gets a DUE notice and NO second MRR booking", async () => {
      const tenantId = await makeTrialTenant("sa668c-s3", "GROWTH");
      await prisma.tenantSubscription.update({
        where: { tenantId },
        data: { basePriceSnapshot: starterPrice },
      });
      // e.g. a manual-mode enable that stored the price: priced, booked by the crossing, but nothing
      // on a Stripe invoice will ever bill it — it must still reach the owner's invoice
      await addAddon(tenantId, "FORECASTING", 2, { priceSnapshot: 19 });

      await activate(tenantId, "ref-s3");

      // the CROSSING booked the stored 19 × 2 once; the pricing helper booked nothing more
      expect((await events(tenantId, "addon.enabled")).map((e) => Number(e.amountDelta))).toEqual([
        38,
      ]);
      expect(await ledgerSum(tenantId)).toBe(starterPrice + 38);
      const row = await prisma.tenantAddon.findFirstOrThrow({ where: { tenantId } });
      expect(Number(row.priceSnapshot)).toBe(19); // no pricing write
      const due = await notices(tenantId);
      expect(due).toHaveLength(1);
      expect(due[0].meta).toMatchObject({
        sku: "FORECASTING",
        quantity: 2,
        monthlyPrice: 19,
        kind: "add",
      });
    });

    it("M-A: an ACTIVE manual tenant RENEWING prices NOTHING — a $0 item-less add-on gets no price, no MRR and no notice", async () => {
      const tenantId = await makeTrialTenant("sa668c-ma-renew", "GROWTH");
      await prisma.tenantSubscription.update({
        where: { tenantId },
        data: { basePriceSnapshot: starterPrice },
      });
      await activate(tenantId, "ref-ma-1"); // the TRIAL -> ACTIVE crossing, no add-ons yet
      await addAddon(tenantId, "CUSTOMER_PACK_100", 2); // appears afterwards: $0, no Stripe item
      const sum = await ledgerSum(tenantId);
      const count = await prisma.billingEvent.count({ where: { tenantId } });

      await activate(tenantId, "ref-ma-2"); // renewal of an already-ACTIVE manual tenant

      const row = await prisma.tenantAddon.findFirstOrThrow({ where: { tenantId } });
      expect(Number(row.priceSnapshot)).toBe(0);
      expect(await ledgerSum(tenantId)).toBe(sum);
      expect(await prisma.billingEvent.count({ where: { tenantId } })).toBe(count);
      expect(await notices(tenantId)).toHaveLength(0);
    });

    const lapse = (tenantId: string, readOnlyReason: string | null) =>
      prisma.tenant.update({
        where: { id: tenantId },
        data: { status: TenantStatus.READ_ONLY, readOnlyReason },
      });

    it.each(["trial_expired", "trial_cancelled"])(
      "MUST-A1: a LAPSED trial (READ_ONLY + %s) activated manually is priced, booked once and announced like a trial",
      async (reason) => {
        const tenantId = await makeTrialTenant(`sa668c-a1-${reason}`.slice(0, 40), "GROWTH");
        await prisma.tenantSubscription.update({
          where: { tenantId },
          data: { basePriceSnapshot: starterPrice },
        });
        await addAddon(tenantId, "CUSTOMER_PACK_100", 2);
        await addAddon(tenantId, "FORECASTING", 1);
        await lapse(tenantId, reason);
        const pack = await catalogPrice("CUSTOMER_PACK_100");
        const forecasting = await catalogPrice("FORECASTING");

        await activate(tenantId, `ref-a1-${reason}`);

        const rows = await prisma.tenantAddon.findMany({
          where: { tenantId },
          orderBy: { sku: "asc" },
        });
        expect(rows.map((r) => [r.sku, Number(r.priceSnapshot)])).toEqual([
          ["CUSTOMER_PACK_100", pack],
          ["FORECASTING", forecasting],
        ]);
        // the crossing books the base; each add-on's delta is booked once after it
        expect(await ledgerSum(tenantId)).toBe(starterPrice + pack * 2 + forecasting);
        expect(
          (await events(tenantId, "addon.enabled")).map((e) => Number(e.amountDelta)).sort(),
        ).toEqual([pack * 2, forecasting].sort());
        expect((await notices(tenantId)).map((n) => (n.meta as any).sku).sort()).toEqual([
          "CUSTOMER_PACK_100",
          "FORECASTING",
        ]);
        expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status).toBe(
          TenantStatus.ACTIVE,
        );

        // IDEMPOTENT: a renewal books nothing and writes no second notice
        const sum = await ledgerSum(tenantId);
        await activate(tenantId, `ref-a1b-${reason}`);
        expect(await ledgerSum(tenantId)).toBe(sum);
        expect(await notices(tenantId)).toHaveLength(2);
      },
    );

    it("MUST-A1: READ_ONLY after a cancelled PAID subscription is not a lapsed trial — manual activation prices nothing", async () => {
      const tenantId = await makeTrialTenant("sa668c-a1-paid", "GROWTH");
      await prisma.tenantSubscription.update({
        where: { tenantId },
        data: { basePriceSnapshot: starterPrice },
      });
      await addAddon(tenantId, "CUSTOMER_PACK_100", 2);
      await lapse(tenantId, "subscription_cancelled");

      await activate(tenantId, "ref-a1-paid");

      expect(
        Number((await prisma.tenantAddon.findFirstOrThrow({ where: { tenantId } })).priceSnapshot),
      ).toBe(0);
      expect(await events(tenantId, "addon.enabled")).toHaveLength(0);
      expect(await notices(tenantId)).toHaveLength(0);
    });

    it("M-A: a SKU with no catalog price (gone, or free) is NOT priced — a DUE notice says 'price unknown — set it before invoicing'", async () => {
      const tenantId = await makeTrialTenant("sa668c-ma-price", "GROWTH");
      await prisma.tenantSubscription.update({
        where: { tenantId },
        data: { basePriceSnapshot: starterPrice },
      });
      await addAddon(tenantId, "CUSTOMER_PACK_100", 2);
      await addAddon(tenantId, "FORECASTING", 1);

      await activateOn(makeAdmin(catalogWithNoUsablePrices()), tenantId, "ref-ma-price");

      const rows = await prisma.tenantAddon.findMany({
        where: { tenantId },
        orderBy: { sku: "asc" },
      });
      expect(rows.map((r) => [r.sku, Number(r.priceSnapshot)])).toEqual([
        ["CUSTOMER_PACK_100", 0],
        ["FORECASTING", 0],
      ]);
      expect(await events(tenantId, "addon.enabled")).toHaveLength(0);
      expect(await ledgerSum(tenantId)).toBe(starterPrice); // the base alone
      const due = await notices(tenantId);
      expect(due.map((n) => [(n.meta as any).sku, (n.meta as any).reason]).sort()).toEqual([
        ["CUSTOMER_PACK_100", "price_unknown"],
        ["FORECASTING", "price_unknown"],
      ]);
      for (const n of due) {
        expect((n.meta as any).message).toContain("price unknown — set it before invoicing");
        expect((n.meta as any).monthlyPrice).toBe(0);
      }
    });

    it("M-A: a row with no quantity is NOT priced (never price × 1 against a 0 row) — a DUE notice says 'quantity missing'", async () => {
      const tenantId = await makeTrialTenant("sa668c-ma-qty", "GROWTH");
      await prisma.tenantSubscription.update({
        where: { tenantId },
        data: { basePriceSnapshot: starterPrice },
      });
      await addAddon(tenantId, "CUSTOMER_PACK_100", 0);

      await activate(tenantId, "ref-ma-qty");

      const row = await prisma.tenantAddon.findFirstOrThrow({ where: { tenantId } });
      expect(Number(row.priceSnapshot)).toBe(0);
      expect(await events(tenantId, "addon.enabled")).toHaveLength(0);
      expect(await ledgerSum(tenantId)).toBe(starterPrice);
      const due = await notices(tenantId);
      expect(due).toHaveLength(1);
      expect(due[0].meta).toMatchObject({
        sku: "CUSTOMER_PACK_100",
        reason: "quantity_missing",
        quantity: 0,
        message: expect.stringContaining("quantity missing — set it before invoicing"),
      });
    });

    it("M-A: an ANNUAL activation — the notice carries the cycle and the per-cycle amount; the ledger books the MONTHLY delta", async () => {
      const tenantId = await makeTrialTenant("sa668c-ma-annual", "GROWTH");
      await prisma.tenantSubscription.update({
        where: { tenantId },
        data: { basePriceSnapshot: starterPrice },
      });
      await addAddon(tenantId, "CUSTOMER_PACK_100", 2);
      const pack = await catalogPrice("CUSTOMER_PACK_100");

      await activateOn(platformAdmin, tenantId, "ref-ma-annual", 365);

      // MRR is monthly whatever the invoice cycle: base + pack × 2
      expect(await ledgerSum(tenantId)).toBe(starterPrice + pack * 2);
      expect((await events(tenantId, "addon.enabled")).map((e) => Number(e.amountDelta))).toEqual([
        pack * 2,
      ]);
      const due = await notices(tenantId);
      expect(due).toHaveLength(1);
      expect(due[0].meta).toMatchObject({
        sku: "CUSTOMER_PACK_100",
        monthlyPrice: pack,
        quantity: 2,
        cycle: "ANNUAL",
        cycleAmount: pack * 10 * 2, // annual price = 10 months, per unit, × quantity
        message: expect.stringContaining("per year"),
      });
    });

    it("M-A NIT: a non-PRODUCTION tenant is never announced (and books no MRR)", async () => {
      const tenantId = await makeTrialTenant("sa668c-ma-test", "GROWTH", TenantClass.TEST);
      await addAddon(tenantId, "CUSTOMER_PACK_100", 2);
      await addAddon(tenantId, "FORECASTING", 1, { priceSnapshot: 19 });

      await activate(tenantId, "ref-ma-test");

      expect(await notices(tenantId)).toHaveLength(0);
      expect(await prisma.billingEvent.count({ where: { tenantId } })).toBe(0);
    });

    it("M-A: TWO simultaneous activations of one trial price, book and announce each add-on exactly once", async () => {
      const tenantId = await makeTrialTenant("sa668c-ma-race", "GROWTH");
      await prisma.tenantSubscription.update({
        where: { tenantId },
        data: { basePriceSnapshot: starterPrice },
      });
      await addAddon(tenantId, "CUSTOMER_PACK_100", 2);
      await addAddon(tenantId, "FORECASTING", 1);
      const pack = await catalogPrice("CUSTOMER_PACK_100");
      const forecasting = await catalogPrice("FORECASTING");

      await Promise.all([activate(tenantId, "ref-ma-race-a"), activate(tenantId, "ref-ma-race-b")]);

      expect(await ledgerSum(tenantId)).toBe(starterPrice + pack * 2 + forecasting);
      expect(await events(tenantId, "plan.changed")).toHaveLength(1);
      expect(await events(tenantId, "addon.enabled")).toHaveLength(2);
      expect((await notices(tenantId)).map((n) => (n.meta as any).sku).sort()).toEqual([
        "CUSTOMER_PACK_100",
        "FORECASTING",
      ]);
    });
  },
);
