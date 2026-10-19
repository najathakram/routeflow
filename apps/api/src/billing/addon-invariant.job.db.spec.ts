/**
 * SA-788 (b) - the daily add-on invariant against real Postgres (B-R1..B-R4). The unit spec
 * (addon-invariant.job.spec.ts) proves the checks, the dedupe claim and the dark e-mail over mocks; this proves what
 * only a database proves: the paged reads, the unique (tenantId, milestone, key) claim, the notice row, and that a
 * TEST-class or deleted tenant is never read.
 *
 * Throwaway `qa-sa788-*` tenants (assertTestTenant). The sweep scans the whole scratch DB, so every assertion is
 * scoped to this run's tenant ids. Stripe, the catalog version and e-mail are stand-ins.
 */
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { AddonInvariantJob } from "./addon-invariant.job";
import { PlanCatalogService } from "./plan-catalog.service";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "addon-invariant.job.db.spec.ts";

describeDb("SA-788 (b) the daily add-on invariant (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let job: AddonInvariantJob;
  let createdVersionId: string | undefined;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;
  const send = jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    createdVersionId = await ensurePublishedCatalog(
      prisma,
      {
        plans: [
          { planKey: "GROWTH", name: "Growth", monthlyPrice: 249 },
          { planKey: "SCALE", name: "Scale", monthlyPrice: 499 },
        ],
        addons: [
          // I3 needs a SKU the SCALE plan bundles; a fresh spec DB has no genesis catalog to say so
          {
            sku: "REGULATED_ITEMS",
            name: "Regulated items",
            monthlyPrice: 39,
            includedAtPlan: "SCALE",
          },
        ],
      },
      SPEC,
    );
    job = new AddonInvariantJob(
      prisma as any,
      new PlanCatalogService(prisma as any),
      { isConfigured: true } as any,
      { sendPlatform: send } as any,
    );
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.billingEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.billingNotificationLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await dropPublishedCatalog(prisma, createdVersionId);
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function tenant(
    label: string,
    o: { cls?: TenantClass; deleted?: boolean; planKey?: string; stripeSubId?: string } = {},
  ) {
    seq += 1;
    const slug = assertTestTenant(`qa-sa788-${run}-${seq}-${label}`, SPEC);
    const t = await prisma.tenant.create({
      data: {
        slug,
        name: slug,
        class: o.cls ?? TenantClass.PRODUCTION,
        status: TenantStatus.ACTIVE,
        deletedAt: o.deleted ? new Date() : null,
      },
    });
    tenantIds.push(t.id);
    await prisma.tenantSubscription.create({
      data: {
        tenantId: t.id,
        planKey: o.planKey ?? "GROWTH",
        basePriceSnapshot: 249,
        stripeSubId: o.stripeSubId ?? `sub_${run}_${seq}`,
        discount: 0,
      } as any,
    });
    return t.id;
  }

  const addon = (tenantId: string, over: Record<string, unknown> = {}) =>
    prisma.tenantAddon.create({
      data: {
        tenantId,
        addonKey: "REGULATED_ITEMS",
        sku: "REGULATED_ITEMS",
        quantity: 1,
        active: true,
        priceSnapshot: 0,
        ...over,
      } as any,
    });

  const mine = async () =>
    (await job.run(new Date())).filter((f) => tenantIds.includes(f.tenantId));

  it("B-R1: a raw-SQL deactivation with no record is ONE I1 finding with one in-app notice; a second run adds none", async () => {
    const t = await tenant("raw");
    const r = await addon(t);
    await pool.query(`UPDATE "TenantAddon" SET active = false, "updatedAt" = now() WHERE id = $1`, [
      r.id,
    ]);

    const first = (await mine()).filter((f) => f.tenantId === t);
    expect(first.map((f) => f.invariant)).toEqual(["I1"]);
    const notices = await prisma.auditLog.findMany({
      where: { tenantId: t, action: "ADDON_INVARIANT_BROKEN" },
    });
    expect(notices).toHaveLength(1);
    expect((await mine()).filter((f) => f.tenantId === t)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled(); // `log` mode: nothing is e-mailed
  });

  it("B-R2: a deactivation through a recorded tenant disable is not a finding", async () => {
    const t = await tenant("recorded");
    const r = await addon(t);
    await prisma.tenantAddon.update({ where: { id: r.id }, data: { active: false } });
    await prisma.billingEvent.create({
      data: {
        tenantId: t,
        type: "addon.state_changed",
        amountDelta: null,
        payload: {
          rowId: r.id,
          addonKey: r.addonKey,
          sku: r.sku,
          changes: { active: [true, false] },
          actor: { kind: "TENANT_USER", id: "u1" },
          source: "tenant.disable",
        },
      },
    });
    expect((await mine()).filter((f) => f.tenantId === t)).toHaveLength(0);
  });

  it("B-R3: an I2 row (a $0 add-on GROWTH does not include, STRIPE) and an I3 row (priced although SCALE includes it)", async () => {
    const t2 = await tenant("i2");
    await addon(t2, { priceSnapshot: 0 });
    const t3 = await tenant("i3", { planKey: "SCALE" });
    await addon(t3, { priceSnapshot: 39, stripeItemId: `si_${run}` });

    const found = await mine();
    expect(found.filter((f) => f.tenantId === t2).map((f) => f.invariant)).toEqual(["I2"]);
    expect(found.filter((f) => f.tenantId === t3).map((f) => f.invariant)).toEqual(["I3"]);
  });

  it("B-R4: a TEST-class tenant and a deleted tenant are never read", async () => {
    const test = await tenant("test", { cls: TenantClass.TEST });
    const gone = await tenant("gone", { deleted: true });
    for (const t of [test, gone]) {
      const r = await addon(t);
      await pool.query(
        `UPDATE "TenantAddon" SET active = false, "updatedAt" = now() WHERE id = $1`,
        [r.id],
      );
    }
    expect((await mine()).filter((f) => f.tenantId === test || f.tenantId === gone)).toHaveLength(
      0,
    );
  });
});
