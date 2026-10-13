/**
 * DB-lane spec (SA-736r M2): a `couponFull` tenant is UNBILLED against REAL Postgres rows - `payingWhere`
 * (`couponFull: false`) excludes it, its add-ons leave `mrr` exactly as they leave `ledgerMrr`, and the
 * `couponUnbilledTenants` cohort counts it. The unit mock of computeOverview ignores `where`
 * (mrr.service.spec.ts), so this is the proof that the filters actually filter.
 *
 * Same isolation trick as src/common/mrr.db.spec.ts: the first read, the fixtures and the second read run in
 * ONE RepeatableRead transaction, so the delta reflects exactly this file's rows whatever other suites do.
 *
 * Run via `npm run local:test:db` (compose Postgres) - collected only by `jest.db.config.js`.
 */
import { randomUUID } from "crypto";
import { Prisma, PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { MrrService, type MrrOverview } from "./mrr.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("MrrService - a couponFull tenant is unbilled (SA-736r, real Postgres)", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let before: MrrOverview;
  let after: MrrOverview;
  let priceOfCouponTenant: number;
  const tenantIds: string[] = [];
  const run = randomUUID().slice(0, 8);
  const payingSlug = assertTestTenant(`qa-mrrc-paying-${run}`, "mrr-coupon.db.spec.ts");
  const couponSlug = assertTestTenant(`qa-mrrc-coupon-${run}`, "mrr-coupon.db.spec.ts");

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    await raw.$transaction(
      async (tx) => {
        const svc = new MrrService(tx as any);
        before = await svc.computeOverview();
        const mk = async (slug: string) => {
          const t = await tx.tenant.create({
            data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
          });
          tenantIds.push(t.id);
          return t.id;
        };
        const payingId = await mk(payingSlug);
        const couponId = await mk(couponSlug);
        await tx.tenantSubscription.create({
          data: { tenantId: payingId, planKey: "STARTER", basePriceSnapshot: 59, discount: 0 },
        });
        await tx.tenantSubscription.create({
          data: {
            tenantId: couponId,
            planKey: "GROWTH",
            basePriceSnapshot: 149,
            discount: 0,
            stripeSubId: `sub_qa_${run}`,
            couponFull: true,
            couponId: "cp_qa_pilot",
          },
        });
        // An add-on on the coupon tenant: it must leave `mrr` like the base does.
        await tx.tenantAddon.create({
          data: {
            tenantId: couponId,
            addonKey: "advanced_routes",
            sku: "ADVANCED_ROUTES",
            quantity: 2,
            priceSnapshot: 20,
            active: true,
          },
        });
        priceOfCouponTenant = await svc.priceTenant(couponId, tx as any);
        after = await svc.computeOverview();
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20_000 },
    );
  }, 120_000);

  afterAll(async () => {
    if (raw) await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await raw?.$disconnect();
    await pool?.end();
  });

  it("payingTenants +1 and mrr + 59: only the normal tenant counts (master: +2 and +59 +149 +40)", () => {
    expect(after.payingTenants - before.payingTenants).toBe(1);
    expect(Math.round((after.mrr - before.mrr) * 100) / 100).toBe(59);
    expect(Math.round((after.baseMrr - before.baseMrr) * 100) / 100).toBe(59);
  });

  it("the coupon tenant's add-on leaves addonMrr (mrr == what ledgerMrr would book)", () => {
    expect(Math.round((after.addonMrr - before.addonMrr) * 100) / 100).toBe(0);
  });

  it("couponUnbilledTenants +1, and it is neither zero-priced nor unpriced", () => {
    expect(after.couponUnbilledTenants - before.couponUnbilledTenants).toBe(1);
    expect(after.zeroPricedActiveTenants - before.zeroPricedActiveTenants).toBe(0);
    expect(after.unpricedActiveTenants - before.unpricedActiveTenants).toBe(0);
  });

  it("priceTenant (the admin card) prices the coupon tenant at 0, the same gate", () => {
    expect(priceOfCouponTenant).toBe(0);
  });
});
