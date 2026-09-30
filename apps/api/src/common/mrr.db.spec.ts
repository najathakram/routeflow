/**
 * DB-lane spec for `MrrService.computeOverview()` — REG-743-N9. The FIRST non-mock proof that
 * the platform-wide MRR rollup behaves correctly against REAL Postgres rows: a PRODUCTION
 * paying tenant, a DEMO tenant (excluded by class), a TRIAL tenant (excluded by status), an
 * ACTIVE PRODUCTION "free pilot" whose subscription HAS a planKey but is fully discounted to
 * $0 (REG-743-N5/zeroPricedActiveTenants), and an ACTIVE PRODUCTION row missing a price
 * snapshot (REG-743-F2/unpricedActiveTenants).
 *
 * `computeOverview()` has no tenant/slug scope — it is a whole-table rollup BY DESIGN (that is
 * what "MRR" means) — and this lane's OTHER `.db.spec.ts` files run concurrently against the
 * same shared local compose database and create fixtures of the exact same shape this spec
 * counts (an ACTIVE PRODUCTION tenant with no subscription, or with a null basePriceSnapshot;
 * see `backfill-subscription-reconciliation.db.spec.ts` and `backfill-tenant-class.db.spec.ts`).
 * A plain before/after delta across two independent `computeOverview()` calls would therefore
 * flake under real concurrency (a sibling worker's fixture, or its own `--apply` pricing a
 * previously-null row, landing inside the window).
 *
 * Fix: `beforeAll` runs the ENTIRE sequence — first read, fixture inserts, second read — inside
 * ONE `RepeatableRead` transaction. Postgres fixes that transaction's snapshot at its first
 * statement; its own later writes are visible to its own later reads (ordinary read-your-writes),
 * but no concurrent transaction's commits made after the snapshot was taken ever become visible
 * to it. The before/after delta computed this way reflects EXACTLY this file's own fixtures,
 * regardless of how many other suites are writing at the same time. The transaction commits
 * normally (this is isolation, not rollback-based cleanup) — `afterAll` still deletes the
 * fixture tenants explicitly.
 *
 * Run via `npm run local:test:db` (compose Postgres) — collected only by `jest.db.config.js`.
 */
import { randomUUID } from "crypto";
import { Prisma, PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";
import { MrrService, type MrrOverview } from "../billing/mrr.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("MrrService.computeOverview — real Postgres (REG-743-N9)", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let before: MrrOverview;
  let after: MrrOverview;
  const tenantIds: string[] = [];
  const run = randomUUID().slice(0, 8);

  const payingSlug = assertTestTenant(`qa-mrr-paying-${run}`, "mrr.db.spec.ts");
  const demoSlug = assertTestTenant(`qa-mrr-demo-${run}`, "mrr.db.spec.ts");
  const trialSlug = assertTestTenant(`qa-mrr-trial-${run}`, "mrr.db.spec.ts");
  const pilotSlug = assertTestTenant(`qa-mrr-pilot-${run}`, "mrr.db.spec.ts");
  const unpricedSlug = assertTestTenant(`qa-mrr-unpriced-${run}`, "mrr.db.spec.ts");
  const noSubSlug = assertTestTenant(`qa-mrr-nosub-${run}`, "mrr.db.spec.ts");
  const noPlanKeySlug = assertTestTenant(`qa-mrr-noplankey-${run}`, "mrr.db.spec.ts");

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });

    await raw.$transaction(
      async (tx) => {
        const svc = new MrrService(tx as any);
        before = await svc.computeOverview();

        async function makeTenant(
          slug: string,
          classValue: TenantClass,
          status: TenantStatus,
        ): Promise<string> {
          const t = await tx.tenant.create({
            data: { slug, name: slug, class: classValue, status },
          });
          tenantIds.push(t.id);
          return t.id;
        }

        const payingId = await makeTenant(payingSlug, TenantClass.PRODUCTION, TenantStatus.ACTIVE);
        const demoId = await makeTenant(demoSlug, TenantClass.DEMO, TenantStatus.ACTIVE);
        await makeTenant(trialSlug, TenantClass.PRODUCTION, TenantStatus.TRIAL);
        const pilotId = await makeTenant(pilotSlug, TenantClass.PRODUCTION, TenantStatus.ACTIVE);
        const unpricedId = await makeTenant(
          unpricedSlug,
          TenantClass.PRODUCTION,
          TenantStatus.ACTIVE,
        );
        await makeTenant(noSubSlug, TenantClass.PRODUCTION, TenantStatus.ACTIVE); // no subscription row
        const noPlanKeyId = await makeTenant(
          noPlanKeySlug,
          TenantClass.PRODUCTION,
          TenantStatus.ACTIVE,
        );

        await tx.tenantSubscription.create({
          data: { tenantId: payingId, planKey: "STARTER", basePriceSnapshot: 59, discount: 0 },
        });
        // DEMO tenant on a real paid plan — must be entirely invisible to revenue (class filter).
        await tx.tenantSubscription.create({
          data: { tenantId: demoId, planKey: "SCALE", basePriceSnapshot: 349, discount: 0 },
        });
        // ACTIVE PRODUCTION "free pilot": a REAL subscription (has a planKey) discounted to
        // exactly $0 — zeroPricedActiveTenants' case, proven against a real Decimal column.
        await tx.tenantSubscription.create({
          data: { tenantId: pilotId, planKey: "GROWTH", basePriceSnapshot: 149, discount: 149 },
        });
        // ACTIVE PRODUCTION, has a planKey, but no price snapshot yet (e.g. a pre-webhook
        // Stripe row) — unpricedActiveTenants' case.
        await tx.tenantSubscription.create({
          data: { tenantId: unpricedId, planKey: "GROWTH", basePriceSnapshot: null, discount: 0 },
        });
        // ACTIVE PRODUCTION, has a subscription row, but no planKey was ever backfilled onto
        // it (the legacy Stripe-only shape, REG-743-F3) — structurally excluded from
        // payingWhere, so it must still register in activeWithoutSubscription.
        await tx.tenantSubscription.create({
          data: { tenantId: noPlanKeyId, planKey: null, basePriceSnapshot: 99, discount: 0 },
        });

        after = await svc.computeOverview();
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20_000 },
    );
  }, 120_000);

  afterAll(async () => {
    // TenantSubscription cascades on Tenant delete (schema: onDelete: Cascade).
    if (raw) await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await raw?.$disconnect();
    await pool?.end();
  });

  it("REG-743-N9 computeOverview against real rows: PRODUCTION paying = price, DEMO = 0, TRIAL = 0", () => {
    expect(after.mrr - before.mrr).toBe(59); // only the paying row's $59 — DEMO and the
    // fully-discounted pilot both net to $0
    expect(after.payingTenants - before.payingTenants).toBe(1);
    expect(after.trialTenants - before.trialTenants).toBe(1); // the TRIAL row, and only it
  });

  it("REG-743-N5/F2 full-discount pilot is zero-priced (not paying), the null-snapshot row is unpriced, both distinct from activeWithoutSubscription", () => {
    expect(after.zeroPricedActiveTenants - before.zeroPricedActiveTenants).toBe(1); // the pilot
    expect(after.unpricedActiveTenants - before.unpricedActiveTenants).toBe(1); // the null snapshot
    // no-sub tenant + the no-planKey legacy tenant (REG-743-F3) — both "nothing billable".
    expect(after.activeWithoutSubscription - before.activeWithoutSubscription).toBe(2);
  });
});
