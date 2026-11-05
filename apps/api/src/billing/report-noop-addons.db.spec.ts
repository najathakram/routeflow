/**
 * SA-1099 §6 (WP5, R23 / T23) on REAL Postgres: `apps/api/scripts/report-noop-addons.mjs` lists the BILLED self-serve
 * add-on purchases that added nothing, and writes nothing. The script runs as a child process against this database
 * (its own connection, the one it ships with); fixtures are made-up `qa-wp5-*` test tenants on a catalog version this
 * spec creates and drops (pinned on each tenant, so no published catalog is needed or touched).
 *
 * Rows: a Starter buyer whose Forecasting flags are courtesy (listed, "courtesy"); a Growth buyer whose plan carries
 * both flags (listed, "plan"); a manually invoiced buyer (price, no Stripe item: listed); and the ones that must NOT
 * be listed: an always-enforced Lite buyer, a comp, the customer pack (capacity), an unbilled row, an inactive row, a
 * buyer with an active DENY on one of the flags. `--enforcement on` switches the courtesy off. Row counts of every
 * table the script could touch are equal before and after.
 */
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SCRIPT = path.resolve(__dirname, "../../scripts/report-noop-addons.mjs");
const FLAGS = ["flag.forecasting", "flag.analytics"];

describeDb("SA-1099 WP5 T23: report-noop-addons.mjs (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let url: string;
  let versionId: string;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  const idOf: Record<string, string> = {};
  const rowOf: Record<string, string> = {};
  let seq = 0;

  async function buyer(
    label: string,
    o: {
      plan: "STARTER" | "GROWTH" | "LITE";
      sku?: string;
      active?: boolean;
      isComp?: boolean;
      stripeItemId?: string | null;
      priceSnapshot?: number | null;
    },
  ) {
    seq += 1;
    const slug = assertTestTenant(`qa-wp5-${run}-${seq}-${label}`, "report-noop-addons.db.spec.ts");
    const planEnum = o.plan === "GROWTH" ? "TEAM" : o.plan;
    const t = await prisma.tenant.create({
      data: {
        slug,
        name: slug,
        class: TenantClass.PRODUCTION,
        status: TenantStatus.ACTIVE,
        plan: planEnum as never,
        planVersionId: versionId,
      },
    });
    tenantIds.push(t.id);
    idOf[label] = t.id;
    await prisma.tenantSubscription.create({
      data: { tenantId: t.id, planKey: o.plan, planVersionId: versionId, discount: 0 } as never,
    });
    const sku = o.sku ?? "FORECASTING";
    const row = await prisma.tenantAddon.create({
      data: {
        tenantId: t.id,
        addonKey: sku,
        sku,
        quantity: 1,
        active: o.active ?? true,
        isComp: o.isComp ?? false,
        stripeItemId: o.stripeItemId === undefined ? `si_wp5_${run}_${seq}` : o.stripeItemId,
        priceSnapshot: o.priceSnapshot === undefined ? 25 : o.priceSnapshot,
      } as never,
    });
    rowOf[label] = row.id;
    return t.id;
  }

  beforeAll(async () => {
    url = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: url });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as never) as unknown as PrismaClient;
    const version =
      ((await prisma.planVersion.aggregate({ _max: { version: true } }))._max.version ?? 0) + 1;
    const created = await prisma.planVersion.create({
      data: {
        version,
        status: "SUPERSEDED",
        notes: "qa fixture — report-noop-addons.db.spec.ts",
        definitions: {
          create: [
            {
              planKey: "STARTER",
              name: "Starter",
              monthlyPrice: 0,
              isCustom: false,
              featureFlags: [],
            },
            {
              planKey: "GROWTH",
              name: "Growth",
              monthlyPrice: 249,
              isCustom: false,
              featureFlags: FLAGS,
            },
            { planKey: "LITE", name: "Lite", monthlyPrice: 0, isCustom: false, featureFlags: [] },
          ],
        },
        addonSkus: {
          create: [
            { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 25, grantsFlags: FLAGS },
            {
              sku: "CUSTOMER_PACK_100",
              name: "Customer pack",
              monthlyPrice: 12,
              stackable: true,
              meteredKey: "CUSTOMERS",
              capacityPerUnit: 100,
              grantsFlags: [],
            },
          ],
        },
      },
    });
    versionId = created.id;

    await buyer("starter-billed", { plan: "STARTER" });
    await buyer("growth-billed", { plan: "GROWTH" });
    await buyer("manual-invoiced", { plan: "STARTER", stripeItemId: null, priceSnapshot: 25 });
    await buyer("lite-billed", { plan: "LITE" });
    await buyer("comp", { plan: "STARTER", isComp: true, stripeItemId: null, priceSnapshot: 0 });
    await buyer("pack", { plan: "STARTER", sku: "CUSTOMER_PACK_100" });
    await buyer("unbilled", { plan: "STARTER", stripeItemId: null, priceSnapshot: 0 });
    await buyer("inactive", { plan: "STARTER", active: false });
    await buyer("denied", { plan: "STARTER" });
    await prisma.tenantFeatureOverride.create({
      data: {
        tenantId: idOf["denied"],
        featureKey: "flag.analytics",
        effect: "DENY",
        reason: "qa fixture",
      } as never,
    });
  }, 120_000);

  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    if (versionId) {
      await prisma.addonSku.deleteMany({ where: { planVersionId: versionId } });
      await prisma.planDefinition.deleteMany({ where: { planVersionId: versionId } });
      await prisma.planVersion.delete({ where: { id: versionId } });
    }
    await prisma?.$disconnect();
    await pool?.end();
  });

  const counts = async () => ({
    addons: await prisma.tenantAddon.count(),
    events: await prisma.billingEvent.count(),
    audit: await prisma.auditLog.count(),
    overrides: await prisma.tenantFeatureOverride.count(),
    tenants: await prisma.tenant.count(),
  });

  function report(args: string[] = []) {
    const r = spawnSync(process.execPath, [SCRIPT, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: url },
      timeout: 90_000,
    });
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout) as {
      enforcement: string;
      test: {
        detail: { id: string; tenantId: string; sku: string; why: Record<string, string> }[];
      };
      live: { detail: unknown[] };
    };
  }
  const mine = (r: ReturnType<typeof report>) =>
    r.test.detail.filter((d) => tenantIds.includes(d.tenantId));

  it("lists exactly the billed no-op purchases, with why, in the TEST block; none of the others", async () => {
    const out = report();
    expect(out.enforcement).toBe("off");
    const listed = mine(out);
    expect(listed.map((d) => d.id).sort()).toEqual(
      [rowOf["starter-billed"], rowOf["growth-billed"], rowOf["manual-invoiced"]].sort(),
    );
    const by = (label: string) => listed.find((d) => d.id === rowOf[label])!;
    expect(by("starter-billed")).toMatchObject({
      sku: "FORECASTING",
      why: { "flag.forecasting": "courtesy", "flag.analytics": "courtesy" },
    });
    expect(by("growth-billed").why).toEqual({
      "flag.forecasting": "plan",
      "flag.analytics": "plan",
    });
    expect(by("manual-invoiced").why["flag.forecasting"]).toBe("courtesy");
    for (const l of ["lite-billed", "comp", "pack", "unbilled", "inactive", "denied"]) {
      expect(listed.map((d) => d.id)).not.toContain(rowOf[l]);
    }
  }, 120_000);

  it("--enforcement on: the courtesy is gone, only the plan-carried purchase is listed", async () => {
    const listed = mine(report(["--enforcement", "on"]));
    expect(listed.map((d) => d.id)).toEqual([rowOf["growth-billed"]]);
  }, 120_000);

  it("writes nothing: the row counts of every table it could touch are the same after both runs", async () => {
    const before = await counts();
    report();
    report(["--enforcement", "on"]);
    expect(await counts()).toEqual(before);
  }, 120_000);

  it("prints no tenant slug and no price", async () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--json"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: url },
      timeout: 90_000,
    });
    expect(r.stdout).not.toMatch(/qa-wp5-/);
    expect(r.stdout).not.toMatch(/priceSnapshot|monthlyPrice/);
  }, 120_000);
});
