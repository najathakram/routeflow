/**
 * DB-lane spec for `../../scripts/report-640-restored-grants.mjs` (row 686 / row 640 census): the two queries (the
 * stamped-restore window and the unstamped partial restore matched by the HELD audit row), the price test at the
 * tenant's PINNED catalog version, the inactive column, and the fail-closed empty catalog, against a REAL Postgres.
 * The pure summary is locked without a database in `report-640-restored-grants-script.spec.ts`.
 *
 * The lane DB may hold other specs' tenants, so the assertions are DELTAS: the census is run once before this file
 * seeds its tenants (after it seeds its catalog) and once after, and the difference must be exactly the fixture.
 * Collected only by `jest.db.config.js`, run via `npm run local:test:db`. SAFETY (L-129): the spec's own qa- tenants
 * (assertTestTenant), the database must be provably local (requireLocalDatabaseUrl), afterAll deletes what this file
 * created. The catalog is global reference data: this file seeds two plan versions with version numbers near the Int
 * ceiling so its PUBLISHED one is the latest, and removes them.
 *
 * The census fails closed on EVERY PUBLISHED plan version, so a PUBLISHED catalog left by another spec in the same DB
 * would break it (exit 3). So this file never publishes anything in the real catalog: its versions live in `public` as
 * DRAFT / SUPERSEDED, and a per-run scratch schema holds shadow copies of the two catalog tables where the PUBLISHED
 * flag is set. The CLI reads it through `search_path = scratch, public` (it names its tables unqualified), so it sees
 * this file's catalog and nothing else's, and the "no PUBLISHED version" case flips only the scratch copy.
 */
import { execFileSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/report-640-restored-grants.mjs");
const RUN = randomUUID().slice(0, 8);
const HELD = "CONFIG_SNAPSHOT_RESTORE_HELD";
const VERSION_BASE = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
/** The scratch schema that shadows the catalog tables for the CLI (RUN is hex, so this is a safe identifier). */
const SCRATCH = `r640_${RUN}`;

type Census = {
  snapshots: { total: number; restored: number };
  restoredGrants: number;
  byKind: Record<string, number>;
  nonCompWithoutPricedRow: number;
  inactiveGrants: number;
  unstampedPossible: {
    grants: number;
    byKind: Record<string, number>;
    nonCompWithoutPricedRow: number;
    inactiveGrants: number;
  };
};

describeDb("report-640-restored-grants.mjs, real Postgres", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let dbUrl: string;
  const tenantIds: string[] = [];
  const versionIds: string[] = [];
  let publishedId: string;
  let baseline: Census;

  const cliEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
    }
    // the CLI names its tables unqualified, so the scratch catalog shadows the real one for it alone
    const url = new URL(dbUrl);
    url.searchParams.set("options", `-c search_path=${SCRATCH},public`);
    env.DATABASE_URL = url.toString();
    return env;
  };
  /** Copies these (non-PUBLISHED) versions and their SKUs into the scratch catalog; `publish` is set PUBLISHED there. */
  const shadow = async (ids: string[], publish: string[]) => {
    await pool.query(
      `INSERT INTO "${SCRATCH}"."PlanVersion" SELECT * FROM public."PlanVersion" WHERE id::text = ANY($1::text[])`,
      [ids],
    );
    await pool.query(
      `INSERT INTO "${SCRATCH}"."AddonSku" SELECT * FROM public."AddonSku" WHERE "planVersionId"::text = ANY($1::text[])`,
      [ids],
    );
    await pool.query(
      `UPDATE "${SCRATCH}"."PlanVersion" SET status = 'PUBLISHED' WHERE id::text = ANY($1::text[])`,
      [publish],
    );
  };
  const census = (): Census =>
    JSON.parse(
      execFileSync("node", [CLI, "--json"], { cwd: API_DIR, encoding: "utf8", env: cliEnv() }),
    );
  const newTenant = async (suffix: string, planVersionId?: string) => {
    const slug = assertTestTenant(
      `qa-r640-${suffix}-${RUN}`,
      "report-640-restored-grants.db.spec.ts",
    );
    const id = (
      await prisma.tenant.create({
        data: { slug, name: `r640 ${slug}`, ...(planVersionId ? { planVersionId } : {}) },
      })
    ).id;
    tenantIds.push(id);
    return id;
  };
  const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);
  const override = (
    tenantId: string,
    featureKey: string,
    kind: "PILOT" | "COMP",
    createdAt: Date,
    opts: { effect?: "GRANT" | "DENY"; revoked?: boolean; expired?: boolean } = {},
  ) =>
    // a partial unique index allows one non-revoked row per (tenant, key); the census does not filter on revokedAt
    prisma.tenantFeatureOverride.create({
      data: {
        tenantId,
        featureKey,
        kind,
        effect: opts.effect ?? "GRANT",
        reason: "spec",
        createdAt,
        revokedAt: opts.revoked ? new Date() : null,
        expiresAt: opts.expired ? new Date(Date.now() - 3_600_000) : null,
      },
    });
  const restoredSnapshot = (tenantId: string, restoredAt: Date) =>
    prisma.tenantFeatureConfigSnapshot.create({
      data: {
        tenantId,
        planKey: "PRO",
        reason: "MANUAL",
        payload: {},
        restoredAt,
        restoredToPlanKey: "PRO",
      },
    });
  const sku = (planVersionId: string, code: string, monthlyPrice: number) =>
    prisma.addonSku.create({
      data: { planVersionId, sku: code, name: code, monthlyPrice, grantsFlags: [] },
    });

  beforeAll(async () => {
    dbUrl = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: dbUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    // Latest catalog (A, PUBLISHED in the scratch shadow only): OCR_PACK_250 is priced, REGULATED_ITEMS is free. An
    // older, superseded version (B): the reverse. A tenant pinned to B must be judged on B, not on the latest.
    const a = await prisma.planVersion.create({
      data: { version: VERSION_BASE, status: "DRAFT", publishedAt: new Date() },
    });
    publishedId = a.id;
    const b = await prisma.planVersion.create({
      data: { version: VERSION_BASE - 1, status: "SUPERSEDED" },
    });
    versionIds.push(a.id, b.id);
    await sku(a.id, "OCR_PACK_250", 10);
    await sku(a.id, "REGULATED_ITEMS", 0);
    await sku(b.id, "OCR_PACK_250", 0);
    await sku(b.id, "REGULATED_ITEMS", 10);

    await pool.query(`CREATE SCHEMA "${SCRATCH}"`);
    for (const table of ["PlanVersion", "AddonSku"]) {
      await pool.query(
        `CREATE TABLE "${SCRATCH}"."${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING INDEXES)`,
      );
    }
    await shadow([a.id, b.id], [a.id]);

    baseline = census();

    const t0 = new Date(Date.now() - 3_600_000);

    // s: stamped restore, pinned to B. In-window grants count; a late one, a DENY and a non-billable key do not.
    // Its live ocr grant is NOT harm (B does not price OCR_PACK_250); the revoked one is inactive.
    const s = await newTenant("s", b.id);
    await restoredSnapshot(s, t0);
    await override(s, "ocr", "PILOT", at(t0, 2));
    await override(s, "ocr", "PILOT", at(t0, 3), { revoked: true });
    await override(s, "tobacco_dealer", "COMP", at(t0, 4));
    await override(s, "ocr", "PILOT", at(t0, 60), { revoked: true }); // outside the window
    await override(s, "ocr", "PILOT", at(t0, 2), { effect: "DENY", revoked: true }); // not a GRANT
    await override(s, "forecasting", "PILOT", at(t0, 2)); // not a billable key

    // s2: unpinned, so judged on the latest PUBLISHED (A): the live ocr grant is harm, the tobacco one is not (free).
    const s2 = await newTenant("s2");
    await restoredSnapshot(s2, t0);
    await override(s2, "ocr", "PILOT", at(t0, 2));
    await override(s2, "tobacco_dealer", "PILOT", at(t0, 2));

    // s3 / s4: a revoked and an expired grant on a priced SKU are inactive, never harm.
    const s3 = await newTenant("s3");
    await restoredSnapshot(s3, t0);
    await override(s3, "ocr", "PILOT", at(t0, 2), { revoked: true });
    const s4 = await newTenant("s4");
    await restoredSnapshot(s4, t0);
    await override(s4, "ocr", "PILOT", at(t0, 2), { expired: true });

    // A partial restore: the snapshot stays unstamped, the HELD audit row is written just after the overrides.
    // Two HELD rows inside the window must not double count the overrides.
    const partial = await newTenant("u");
    const u0 = new Date(Date.now() - 1_800_000);
    await override(partial, "ocr", "PILOT", at(u0, -3), { revoked: true });
    await override(partial, "ocr", "PILOT", at(u0, -2));
    await override(partial, "tobacco_dealer", "PILOT", at(u0, -1));
    await override(partial, "ocr", "PILOT", at(u0, -60), { revoked: true }); // long before the audit row
    for (const sec of [0, 1]) {
      await prisma.auditLog.create({
        data: {
          tenantId: partial,
          action: HELD,
          entityType: "TenantFeatureConfigSnapshot",
          createdAt: at(u0, sec),
        },
      });
    }

    // Control: a GRANT with neither a stamped snapshot nor a HELD audit row.
    const control = await newTenant("c");
    await override(control, "ocr", "PILOT", at(t0, 2));
  }, 180_000);

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of tenantIds) {
      await prisma.auditLog.deleteMany({ where: { tenantId } }).catch(swallow);
      await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId } }).catch(swallow);
      await prisma.tenantFeatureConfigSnapshot.deleteMany({ where: { tenantId } }).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await pool.query(`DROP SCHEMA IF EXISTS "${SCRATCH}" CASCADE`).catch(swallow);
    for (const id of versionIds) {
      await prisma.addonSku.deleteMany({ where: { planVersionId: id } }).catch(swallow);
      await prisma.planVersion.delete({ where: { id } }).catch(swallow);
    }
    await prisma.$disconnect();
    await pool.end();
  });

  const delta = (after: number | undefined, before: number | undefined) =>
    (after ?? 0) - (before ?? 0);

  it("counts the stamped restore's grants in the window only", () => {
    const after = census();
    expect(delta(after.snapshots.restored, baseline.snapshots.restored)).toBe(4);
    expect(delta(after.restoredGrants, baseline.restoredGrants)).toBe(7);
    expect(delta(after.byKind.PILOT, baseline.byKind.PILOT)).toBe(6);
    expect(delta(after.byKind.COMP, baseline.byKind.COMP)).toBe(1);
  }, 120_000);

  it("prices each grant at the catalog version the tenant is pinned to, and only where monthlyPrice > 0", () => {
    const after = census();
    // s (pinned to B, OCR free there) is not harm; s2's ocr (A prices it) is; s2's tobacco (A: free) is not.
    // Judged on the latest published for everyone, s's live ocr grant would be a second harm.
    expect(delta(after.nonCompWithoutPricedRow, baseline.nonCompWithoutPricedRow)).toBe(1);
  }, 120_000);

  it("keeps revoked and expired grants out of the harm count, in their own column", () => {
    const after = census();
    // s: 1 revoked in the window; s3: revoked; s4: expired. (s3 and s4 would each be harm if they were live.)
    expect(delta(after.inactiveGrants, baseline.inactiveGrants)).toBe(3);
  }, 120_000);

  it("reports an unstamped partial restore separately, once per override, never as a restored grant", () => {
    const after = census();
    expect(delta(after.unstampedPossible.grants, baseline.unstampedPossible.grants)).toBe(3);
    expect(
      delta(after.unstampedPossible.byKind.PILOT, baseline.unstampedPossible.byKind.PILOT),
    ).toBe(3);
    expect(
      delta(
        after.unstampedPossible.nonCompWithoutPricedRow,
        baseline.unstampedPossible.nonCompWithoutPricedRow,
      ),
    ).toBe(1);
    expect(
      delta(after.unstampedPossible.inactiveGrants, baseline.unstampedPossible.inactiveGrants),
    ).toBe(1);
  }, 120_000);

  it("fails closed with exit 3 when no plan version is PUBLISHED, never a harm count of 0", async () => {
    // only the scratch shadow is flipped: the real catalog is never touched
    await pool.query(
      `UPDATE "${SCRATCH}"."PlanVersion" SET status = 'DRAFT' WHERE status = 'PUBLISHED'`,
    );
    try {
      const r = spawnSync("node", [CLI, "--json"], {
        cwd: API_DIR,
        encoding: "utf8",
        env: cliEnv(),
      });
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/no PUBLISHED plan version/);
      expect(r.stdout.trim()).toBe("");
    } finally {
      await pool.query(
        `UPDATE "${SCRATCH}"."PlanVersion" SET status = 'PUBLISHED' WHERE id::text = $1`,
        [publishedId],
      );
    }
  }, 120_000);

  it("fails closed with exit 3 when a PUBLISHED version lists only one of the billable SKUs", async () => {
    // a newer PUBLISHED version that omits REGULATED_ITEMS: the old check (any SKU row on the latest version) passed it
    const c = await prisma.planVersion.create({
      data: { version: VERSION_BASE + 1, status: "DRAFT", publishedAt: new Date() },
    });
    versionIds.push(c.id);
    await sku(c.id, "OCR_PACK_250", 10);
    await shadow([c.id], [c.id]);
    try {
      const r = spawnSync("node", [CLI, "--json"], {
        cwd: API_DIR,
        encoding: "utf8",
        env: cliEnv(),
      });
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/does not list REGULATED_ITEMS/);
      expect(r.stdout.trim()).toBe("");
    } finally {
      await pool.query(`DELETE FROM "${SCRATCH}"."AddonSku" WHERE "planVersionId"::text = $1`, [
        c.id,
      ]);
      await pool.query(`DELETE FROM "${SCRATCH}"."PlanVersion" WHERE id::text = $1`, [c.id]);
      await prisma.addonSku.deleteMany({ where: { planVersionId: c.id } });
      await prisma.planVersion.delete({ where: { id: c.id } });
      versionIds.splice(versionIds.indexOf(c.id), 1);
    }
  }, 120_000);

  it("writes nothing and prints no tenant id or slug", async () => {
    const before = await prisma.tenantFeatureOverride.count({
      where: { tenantId: { in: tenantIds } },
    });
    const out = execFileSync("node", [CLI, "--json"], {
      cwd: API_DIR,
      encoding: "utf8",
      env: cliEnv(),
    });
    for (const id of tenantIds) expect(out).not.toContain(id);
    expect(out).not.toMatch(/qa-r640/);
    expect(
      await prisma.tenantFeatureOverride.count({ where: { tenantId: { in: tenantIds } } }),
    ).toBe(before);
  }, 120_000);
});
