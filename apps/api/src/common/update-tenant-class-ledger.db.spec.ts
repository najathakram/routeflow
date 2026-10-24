/**
 * DB-lane spec for `PlatformAdminService.updateTenantClass()` — SA-140 (B557 item 2), against
 * real Postgres. `MrrService.computeOverview()`'s `ledgerAgg` sums `BillingEvent.amountDelta`
 * `WHERE tenant.class = 'PRODUCTION'` — a join evaluated against the tenant's CURRENT class,
 * not class-at-event-time. Before this fix, flipping a tenant into PRODUCTION retroactively
 * imported its entire pre-existing `amountDelta` history into that SUM in one step, with
 * nothing compensating for the import. This proves the compensating `TENANT_CLASS_CHANGED`
 * entry lands, and that it makes the tenant's real ledger contribution equal its live
 * `priceTenant()` value at the instant of the transition — not the imported historical total.
 *
 * `PlatformAdminService` is constructed directly (bypassing Nest DI) with REAL `PrismaService`,
 * `BillingEventService`, and `MrrService` (the only three collaborators `updateTenantClass()`
 * itself touches) and lightweight stand-ins for every other constructor dependency, none of
 * which that method calls.
 *
 * Run via `npm run local:test:db` (compose Postgres) — collected only by `jest.db.config.js`.
 */
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";
import { PlatformAdminService } from "../platform-admin/platform-admin.service";
import { BillingEventService } from "../billing/billing-event.service";
import { MrrService } from "../billing/mrr.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "PlatformAdminService.updateTenantClass — real Postgres ledger (SA-140/B557 item 2)",
  () => {
    let pool: Pool;
    let prisma: PrismaClient;
    let service: PlatformAdminService;
    const tenantIds: string[] = [];
    const run = randomUUID().slice(0, 8);

    beforeAll(() => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

      const noop = {} as any;
      service = new PlatformAdminService(
        prisma as any,
        noop, // jwtService — unused by updateTenantClass
        noop, // config
        noop, // emailService
        noop, // billingService
        noop, // platformPricingService
        noop, // planCatalogService
        noop, // proration
        noop, // entitlementsService
        new BillingEventService(prisma as any),
        noop, // meterService
        noop, // tenantStatusGuard
        { log: jest.fn().mockResolvedValue(undefined) } as any, // auditService — recordAdminAction()
        new MrrService(prisma as any),
        noop, // tenantMirror
        noop, // featureOverrides
        noop, // planTransition
        noop, // stripe
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

    it("entering PRODUCTION books a compensating delta that nets the tenant's ledger contribution to its live priceTenant() value, not the imported historical total", async () => {
      const slug = assertTestTenant(
        `qa-tclass-enter-${run}`,
        "update-tenant-class-ledger.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({
        data: { slug, name: slug, class: TenantClass.DEMO, status: TenantStatus.ACTIVE },
      });
      tenantIds.push(tenant.id);
      await prisma.tenantSubscription.create({
        data: { tenantId: tenant.id, planKey: "STARTER", basePriceSnapshot: 59, discount: 0 },
      });
      // Pre-existing history accumulated while NOT PRODUCTION — unrelated to the tenant's real
      // (going-forward) run-rate. Sums to $150; the tenant's live contribution once PRODUCTION is
      // its $59 base (no add-ons).
      await prisma.billingEvent.createMany({
        data: [
          { tenantId: tenant.id, type: "plan.changed", payload: {}, amountDelta: 100 },
          { tenantId: tenant.id, type: "plan.changed", payload: {}, amountDelta: 50 },
        ],
      });
      expect(await ledgerSum(tenant.id)).toBe(150);

      await service.updateTenantClass(tenant.id, { class: "PRODUCTION" } as any, "admin-1");

      const liveContribution = await new MrrService(prisma as any).priceTenant(tenant.id);
      expect(liveContribution).toBe(59);
      // The compensating entry cancels the imported $150 and lands the tenant exactly at its
      // live contribution — never the raw historical sum, never zero.
      expect(await ledgerSum(tenant.id)).toBe(59);

      const events = await prisma.billingEvent.findMany({
        where: { tenantId: tenant.id, type: "tenant.class_changed" },
        select: { amountDelta: true },
      });
      expect(events).toHaveLength(1);
      expect(events[0].amountDelta != null ? Number(events[0].amountDelta) : null).toBe(-91); // 59 − 150
    });

    it("entering PRODUCTION with no pre-existing history books a compensating delta equal to the live contribution alone", async () => {
      const slug = assertTestTenant(
        `qa-tclass-fresh-${run}`,
        "update-tenant-class-ledger.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({
        data: { slug, name: slug, class: TenantClass.TEST, status: TenantStatus.ACTIVE },
      });
      tenantIds.push(tenant.id);
      await prisma.tenantSubscription.create({
        data: { tenantId: tenant.id, planKey: "GROWTH", basePriceSnapshot: 249, discount: 0 },
      });
      expect(await ledgerSum(tenant.id)).toBe(0);

      await service.updateTenantClass(tenant.id, { class: "PRODUCTION" } as any, "admin-1");

      expect(await ledgerSum(tenant.id)).toBe(249);
    });

    it("leaving PRODUCTION books NO compensating delta — the current-class join already drops the tenant's whole history from ledgerAgg", async () => {
      const slug = assertTestTenant(
        `qa-tclass-leave-${run}`,
        "update-tenant-class-ledger.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({
        data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
      });
      tenantIds.push(tenant.id);
      await prisma.tenantSubscription.create({
        data: { tenantId: tenant.id, planKey: "SCALE", basePriceSnapshot: 499, discount: 0 },
      });
      await prisma.billingEvent.create({
        data: { tenantId: tenant.id, type: "plan.changed", payload: {}, amountDelta: 499 },
      });

      await service.updateTenantClass(tenant.id, { class: "DEMO" } as any, "admin-1");

      // The row(s) still exist (append-only) — but this tenant's `tenant.class` is no longer
      // PRODUCTION, so ledgerAgg's join excludes them all going forward, same as `mrr` does.
      expect(await ledgerSum(tenant.id)).toBe(499);
      const events = await prisma.billingEvent.findMany({
        where: { tenantId: tenant.id, type: "tenant.class_changed" },
        select: { amountDelta: true },
      });
      expect(events).toHaveLength(1);
      expect(events[0].amountDelta).toBeNull();
    });

    // #2045 (1) — discriminating PARALLEL case (F2's finding on #2584: every case above is a
    // single call, so it stays green with the class read moved back before the lock). Two
    // CONCURRENT flips into PRODUCTION: with the class read under the Tenant lock, the second call
    // reads PRODUCTION and books nothing ⇒ exactly ONE tenant.class_changed. With the read before
    // the lock (the revert) both calls read DEMO and both book ⇒ TWO.
    it("#2045: two concurrent flips into PRODUCTION book exactly ONE class_changed event; the ledger lands on the live contribution", async () => {
      const slug = assertTestTenant(
        `qa-tclass-race-${run}`,
        "update-tenant-class-ledger.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({
        data: { slug, name: slug, class: TenantClass.DEMO, status: TenantStatus.ACTIVE },
      });
      tenantIds.push(tenant.id);
      await prisma.tenantSubscription.create({
        data: { tenantId: tenant.id, planKey: "STARTER", basePriceSnapshot: 59, discount: 0 },
      });
      await prisma.billingEvent.createMany({
        data: [
          { tenantId: tenant.id, type: "plan.changed", payload: {}, amountDelta: 100 },
          { tenantId: tenant.id, type: "plan.changed", payload: {}, amountDelta: 50 },
        ],
      });

      const results = await Promise.allSettled([
        service.updateTenantClass(tenant.id, { class: "PRODUCTION" } as any, "admin-1"),
        service.updateTenantClass(tenant.id, { class: "PRODUCTION" } as any, "admin-2"),
      ]);

      const events = await prisma.billingEvent.findMany({
        where: { tenantId: tenant.id, type: "tenant.class_changed" },
        select: { amountDelta: true },
      });
      expect({
        statuses: results.map((r) => r.status),
        classChanged: events.length,
        ledger: await ledgerSum(tenant.id),
      }).toEqual({ statuses: ["fulfilled", "fulfilled"], classChanged: 1, ledger: 59 });
    });
  },
);
