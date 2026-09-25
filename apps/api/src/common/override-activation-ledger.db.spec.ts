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
 * `isPayingRow` check — a TRIAL tenant's self-serve add-on writes the `TenantAddon` row (so it
 * prices correctly once the tenant activates) but books nothing. Activation then books the base
 * in one `plan.changed` row and the add-on once, in one `addon.enabled` row, through the same
 * crossing helper `subscribe()` uses (SA-277b) — the total is base + snapshot, exactly once.
 *
 * `PlatformAdminService` and `SubscriptionMutationService` are constructed directly (bypassing
 * Nest DI) with REAL `PrismaService`/`BillingEventService`/`MrrService`/`PlanCatalogService`/
 * `ProrationService` (every collaborator the exercised methods actually touch) and lightweight
 * stand-ins for the rest, mirroring `update-tenant-class-ledger.db.spec.ts`. This spec calls
 * ONLY the public service methods (`updateTenantPriceOverride`, `activateManualSubscription`,
 * `enableAddon`) — never the `addon-ledger.ts` helper directly — so it stays correct whether
 * that helper's internal contract is priceSnapshot/deltaQty or before/after.
 *
 * `dto.plan` activates onto "STARTER" (guaranteed present in any published catalog — every
 * fixture and fallback in this codebase resolves to it) so the test needs no catalog seeding of
 * its own; it relies on the published catalog `npm run local:seed` already publishes.
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

    beforeAll(() => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const noop = {} as any;
      const catalog = new PlanCatalogService(prisma as any);
      const events = new BillingEventService(prisma as any);
      const mrr = new MrrService(prisma as any);

      platformAdmin = new PlatformAdminService(
        prisma as any,
        noop, // jwtService — unused by the methods this spec exercises
        noop, // config
        noop, // emailService
        { syncStripeSubscriptionPrice: jest.fn().mockResolvedValue(undefined) } as any, // billingService
        { resolveTenantPricing: jest.fn().mockResolvedValue({}) } as any, // platformPricingService
        catalog,
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
      if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
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

    async function makeTrialTenant(slugPrefix: string, planKey: string): Promise<string> {
      const slug = assertTestTenant(
        `qa-${slugPrefix}-${run}`,
        "override-activation-ledger.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({
        data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.TRIAL },
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

    it("REG-B865-DB: a TRIAL tenant's self-serve add-on books zero events; manual activation books base + add-on together, exactly once", async () => {
      const tenantId = await makeTrialTenant("b865", "GROWTH");
      // This case's base is already known (unlike B864's null-snapshot shape) — the add-on
      // ledger gate is what's under test here, not the backfill path.
      await prisma.tenantSubscription.update({
        where: { tenantId },
        data: { basePriceSnapshot: 59 },
      });

      const preview = await subscriptionMutation.enableAddon(tenantId, "CUSTOMER_PACK_100", 1);
      expect(preview).toBeDefined();
      expect(await ledgerSum(tenantId)).toBe(0);

      const addon = await prisma.tenantAddon.findUniqueOrThrow({
        where: { tenantId_addonKey: { tenantId, addonKey: "CUSTOMER_PACK_100" } },
        select: { active: true, priceSnapshot: true, quantity: true },
      });
      expect(addon.active).toBe(true);
      const addonPrice = Number(addon.priceSnapshot);
      expect(addonPrice).toBeGreaterThan(0);

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

      expect(await ledgerSum(tenantId)).toBe(59 + addonPrice);

      // SA-277b: base and add-on book as separate rows via the shared crossing helper.
      const plan = await prisma.billingEvent.findMany({
        where: { tenantId, type: "plan.changed" },
        select: { amountDelta: true },
      });
      expect(plan).toHaveLength(1);
      expect(Number(plan[0].amountDelta)).toBe(59);
      const addonRows = await prisma.billingEvent.findMany({
        where: { tenantId, type: "addon.enabled" },
        select: { amountDelta: true },
      });
      expect(addonRows).toHaveLength(1);
      expect(Number(addonRows[0].amountDelta)).toBe(addonPrice);
    });
  },
);
