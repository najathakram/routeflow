/**
 * DB-lane spec (SA-1535 / W-1462 PR-1, pin c): the business tabs and the MRR card agree against REAL Postgres rows.
 * On an unfiltered scan (Show deleted on) the bucket counts sum to the business count; the Paying tab EQUALS
 * payingTenants (SA-1539: paying = the paying set AND priced above 0, REG-743-N5); the Trial tab is trialTenants; the
 * rows carrying subscribed_zero are unpricedActiveTenants + zeroPricedActiveTenants; Not billed is those two plus
 * activeWithoutSubscription plus couponUnbilledTenants (observe-and-report: never bend a fixture to it).
 *
 * Same isolation trick as mrr-coupon.db.spec.ts: the first read, the fixtures and the second read run in ONE
 * RepeatableRead transaction, so the whole-database identity holds whatever else is in the database, and the
 * fixture delta is exactly this file's rows. Test slugs only (`qa-*`), acme names.
 *
 * Run via `npm run local:test:db` (compose Postgres) - collected only by `jest.db.config.js`.
 */
import { randomUUID } from "crypto";
import { Prisma, PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { listTenantsByBucket } from "../platform-admin/tenant-bucket-list";
import { MrrService, type MrrOverview } from "./mrr.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

type Counts = Record<string, number>;

describeDb("tenant buckets vs the MRR card (SA-1535 pin c, real Postgres)", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let overview: MrrOverview;
  let counts: Counts;
  let countsOff: Counts;
  let countsBefore: Counts;
  let subscribedZeroRows = 0;
  let trialStatusInTab = 0;
  let trialExpiredInTab = 0;
  let liveRows = 0;
  let deletedProduction = 0;
  let tenantTotal: number;
  let listedSum: number;
  const tenantIds: string[] = [];
  const run = randomUUID().slice(0, 8);

  const bucketCountsOf = async (tx: Prisma.TransactionClient, includeDeleted = true) => {
    const r = await listTenantsByBucket(tx as any, new MrrService(tx as any), {
      scopeWhere: {},
      orderBy: { createdAt: "desc" },
      page: 1,
      limit: 1,
      status: null,
      includeDeleted,
      buckets: null,
      attention: false,
      include: {},
    });
    return {
      counts: r.meta.bucketCounts as unknown as Counts,
      verdicts: r.verdicts,
      zero: [...r.verdicts.values()].filter((v) => v.attention.includes("subscribed_zero")).length,
    };
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    await raw.$transaction(
      async (tx) => {
        countsBefore = (await bucketCountsOf(tx)).counts;
        const mk = async (
          label: string,
          data: { status: TenantStatus; class?: TenantClass; deletedAt?: Date },
        ) => {
          const slug = assertTestTenant(`qa-bkt-${label}-${run}`, "tenant-bucket.db.spec.ts");
          const t = await tx.tenant.create({
            data: { slug, name: slug, class: TenantClass.PRODUCTION, ...data },
          });
          tenantIds.push(t.id);
          return t.id;
        };
        const sub = (tenantId: string, o: Record<string, unknown>) =>
          tx.tenantSubscription.create({ data: { tenantId, discount: 0, ...o } as any });

        // paying, priced above 0 (payingTenants)
        await sub(await mk("paid", { status: TenantStatus.ACTIVE }), {
          planKey: "STARTER",
          basePriceSnapshot: 59,
        });
        // paying by the one definition, no price snapshot (unpricedActiveTenants)
        await sub(await mk("unpriced", { status: TenantStatus.ACTIVE }), { planKey: "STARTER" });
        // paying by the one definition, a snapshot that nets to $0 (zeroPricedActiveTenants)
        await sub(await mk("zero", { status: TenantStatus.ACTIVE }), {
          planKey: "STARTER",
          basePriceSnapshot: 59,
          discount: 59,
        });
        // comp add-on on a null base snapshot: stays unpriced; an inactive add-on and a discount above the base: not paying
        const compId = await mk("comp", { status: TenantStatus.ACTIVE });
        await sub(compId, { planKey: "STARTER" });
        await tx.tenantAddon.create({
          data: {
            tenantId: compId,
            addonKey: "advanced_routes",
            sku: "ADVANCED_ROUTES",
            quantity: 1,
            priceSnapshot: 20,
            active: true,
            isComp: true,
          },
        });
        const inactiveId = await mk("inactive", { status: TenantStatus.ACTIVE });
        await sub(inactiveId, { planKey: "STARTER" });
        await tx.tenantAddon.create({
          data: {
            tenantId: inactiveId,
            addonKey: "advanced_routes",
            sku: "ADVANCED_ROUTES",
            quantity: 1,
            priceSnapshot: 20,
            active: false,
          },
        });
        await sub(await mk("overdisc", { status: TenantStatus.ACTIVE }), {
          planKey: "STARTER",
          basePriceSnapshot: 59,
          discount: 80,
        });
        // full coupon: not paying (Not billed), not in any MRR bucket
        await sub(await mk("coupon", { status: TenantStatus.ACTIVE }), {
          planKey: "GROWTH",
          basePriceSnapshot: 149,
          couponFull: true,
          couponId: "cp_qa_pilot",
        });
        // active with no subscription: Not billed
        await mk("nosub", { status: TenantStatus.ACTIVE });
        await mk("trial", { status: TenantStatus.TRIAL });
        // READ_ONLY with trial_expired is in the Trial tab but outside the trialTenants equality
        await tx.tenant.update({
          where: { id: await mk("trialx", { status: TenantStatus.READ_ONLY }) },
          data: { readOnlyReason: "trial_expired" },
        });
        await mk("locked", { status: TenantStatus.READ_ONLY });
        await mk("gone", { status: TenantStatus.ACTIVE, deletedAt: new Date() });
        await mk("demo", { status: TenantStatus.ACTIVE, class: TenantClass.DEMO });

        overview = await new MrrService(tx as any).computeOverview();
        const on = await bucketCountsOf(tx);
        const statuses = await tx.tenant.findMany({ select: { id: true, status: true } });
        for (const t of statuses) {
          const v = on.verdicts.get(t.id);
          if (v?.bucket !== "trial") continue;
          if (t.status === TenantStatus.TRIAL) trialStatusInTab += 1;
          else trialExpiredInTab += 1;
        }
        counts = on.counts;
        subscribedZeroRows = on.zero;
        countsOff = (await bucketCountsOf(tx, false)).counts;
        liveRows = await tx.tenant.count({ where: { deletedAt: null } });
        deletedProduction = await tx.tenant.count({
          where: { deletedAt: { not: null }, class: TenantClass.PRODUCTION },
        });
        tenantTotal = await tx.tenant.count();
        listedSum = Object.values(counts).reduce((a, b) => a + b, 0);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 },
    );
    // eslint-disable-next-line no-console
    console.log(
      "bucket-vs-mrr observed:",
      JSON.stringify({
        counts,
        subscribedZeroRows,
        activeWithoutSubscription: overview.activeWithoutSubscription,
        couponUnbilledTenants: overview.couponUnbilledTenants,
        payingTenants: overview.payingTenants,
        unpricedActiveTenants: overview.unpricedActiveTenants,
        zeroPricedActiveTenants: overview.zeroPricedActiveTenants,
        trialTenants: overview.trialTenants,
        tenantTotal,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    if (raw) await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await raw?.$disconnect();
    await pool?.end();
  });

  it("the bucket counts sum to the business count (every business is in exactly one tab)", () => {
    expect(listedSum).toBe(tenantTotal);
  });

  it("Show deleted off: the sum is the live rows plus the deleted real-customer rows (those are always under Closed)", () => {
    const sum = Object.values(countsOff).reduce((x, y) => x + y, 0);
    expect(sum).toBe(liveRows + deletedProduction);
  });

  it("paying bucket count EQUALS payingTenants (no added terms)", () => {
    expect(counts.paying).toBe(overview.payingTenants);
  });

  it("trial: rows with status TRIAL in the tab = trialTenants; the trial_expired READ_ONLY rows are in the tab and outside it", () => {
    expect(trialStatusInTab).toBe(overview.trialTenants);
    expect(counts.trial).toBe(trialStatusInTab + trialExpiredInTab);
    expect(trialExpiredInTab).toBeGreaterThanOrEqual(1);
  });

  it("rows carrying subscribed_zero = unpricedActiveTenants + zeroPricedActiveTenants", () => {
    expect(subscribedZeroRows).toBe(
      overview.unpricedActiveTenants + overview.zeroPricedActiveTenants,
    );
  });

  // OBSERVE AND REPORT (SA-1539 A2): couponUnbilledTenants' where clause was not read by the SA. If this fails, report the
  // row shape; never bend a fixture to it.
  it("not_billed = unpriced + zero-priced + activeWithoutSubscription + couponUnbilledTenants", () => {
    expect(counts.not_billed).toBe(
      overview.unpricedActiveTenants +
        overview.zeroPricedActiveTenants +
        overview.activeWithoutSubscription +
        overview.couponUnbilledTenants,
    );
  });

  it("this file's rows land where they belong (delta over the first read)", () => {
    const dl = (k: string) => counts[k] - countsBefore[k];
    expect(dl("paying")).toBe(1);
    expect(dl("not_billed")).toBe(7); // unpriced, zero-priced, coupon, no subscription, comp add-on, inactive add-on, discount above base
    expect(dl("trial")).toBe(2); // one TRIAL and one READ_ONLY trial_expired
    expect(dl("paused")).toBe(1);
    expect(dl("closed")).toBe(1);
    expect(dl("test_demo")).toBe(1);
  });
});
