/**
 * DB-lane spec for `../../scripts/report-640-restored-grants.mjs` (row 686 / row 640 census): the two queries (the
 * stamped-restore window and the unstamped partial restore matched by the HELD audit row) against a REAL Postgres.
 * The pure summary is locked without a database in `report-640-restored-grants-script.spec.ts`.
 *
 * The lane DB may hold other specs' tenants, so the assertions are DELTAS: the census is run once before this file
 * seeds anything and once after, and the difference must be exactly the fixture. Collected only by
 * `jest.db.config.js`, run via `npm run local:test:db`. SAFETY (L-129): the spec's own qa- tenants
 * (assertTestTenant), the database must be provably local (requireLocalDatabaseUrl), afterAll deletes what this file
 * created. The catalog is global reference data and is not seeded, so nothing here asserts a harm count.
 */
import { execFileSync } from "child_process";
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

type Census = {
  snapshots: { total: number; restored: number };
  restoredGrants: number;
  byKind: Record<string, number>;
  unstampedPossible: { grants: number; byKind: Record<string, number> };
};

describeDb("report-640-restored-grants.mjs, real Postgres", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let dbUrl: string;
  const tenantIds: string[] = [];
  let baseline: Census;

  const census = (): Census => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
    }
    env.DATABASE_URL = dbUrl;
    return JSON.parse(
      execFileSync("node", [CLI, "--json"], { cwd: API_DIR, encoding: "utf8", env }),
    );
  };
  const newTenant = async (suffix: string) => {
    const slug = assertTestTenant(
      `qa-r640-${suffix}-${RUN}`,
      "report-640-restored-grants.db.spec.ts",
    );
    const id = (await prisma.tenant.create({ data: { slug, name: `r640 ${slug}` } })).id;
    tenantIds.push(id);
    return id;
  };
  const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);
  const override = (
    tenantId: string,
    featureKey: string,
    kind: "PILOT" | "COMP",
    createdAt: Date,
    effect: "GRANT" | "DENY" = "GRANT",
    revoked = false,
  ) =>
    // a partial unique index allows one non-revoked row per (tenant, key); the census does not filter on revokedAt
    prisma.tenantFeatureOverride.create({
      data: {
        tenantId,
        featureKey,
        kind,
        effect,
        reason: "spec",
        createdAt,
        revokedAt: revoked ? new Date() : null,
      },
    });

  beforeAll(async () => {
    dbUrl = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: dbUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    baseline = census();

    // A stamped restore: grants inside the 10 s window count, a late one, a DENY and a non-billable key do not.
    const stamped = await newTenant("s");
    const t0 = new Date(Date.now() - 3_600_000);
    await prisma.tenantFeatureConfigSnapshot.create({
      data: {
        tenantId: stamped,
        planKey: "PRO",
        reason: "MANUAL",
        payload: {},
        restoredAt: t0,
        restoredToPlanKey: "PRO",
      },
    });
    await override(stamped, "ocr", "PILOT", at(t0, 2));
    await override(stamped, "ocr", "PILOT", at(t0, 3), "GRANT", true);
    await override(stamped, "tobacco_dealer", "COMP", at(t0, 4));
    await override(stamped, "ocr", "PILOT", at(t0, 60), "GRANT", true); // outside the window
    await override(stamped, "ocr", "PILOT", at(t0, 2), "DENY", true); // not a GRANT
    await override(stamped, "forecasting", "PILOT", at(t0, 2)); // not a billable key

    // A partial restore: the snapshot stays unstamped, the HELD audit row is written just after the overrides.
    // Two HELD rows inside the window must not double count the overrides.
    const partial = await newTenant("u");
    const u0 = new Date(Date.now() - 1_800_000);
    await override(partial, "ocr", "PILOT", at(u0, -3), "GRANT", true);
    await override(partial, "ocr", "PILOT", at(u0, -2));
    await override(partial, "tobacco_dealer", "PILOT", at(u0, -1));
    await override(partial, "ocr", "PILOT", at(u0, -60), "GRANT", true); // long before the audit row
    for (const s of [0, 1]) {
      await prisma.auditLog.create({
        data: {
          tenantId: partial,
          action: HELD,
          entityType: "TenantFeatureConfigSnapshot",
          createdAt: at(u0, s),
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
    await prisma.$disconnect();
    await pool.end();
  });

  const delta = (after: number | undefined, before: number | undefined) =>
    (after ?? 0) - (before ?? 0);

  it("counts the stamped restore's grants in the window only", () => {
    const after = census();
    expect(delta(after.snapshots.restored, baseline.snapshots.restored)).toBe(1);
    expect(delta(after.restoredGrants, baseline.restoredGrants)).toBe(3);
    expect(delta(after.byKind.PILOT, baseline.byKind.PILOT)).toBe(2);
    expect(delta(after.byKind.COMP, baseline.byKind.COMP)).toBe(1);
  }, 120_000);

  it("reports an unstamped partial restore separately, once per override, never as a restored grant", () => {
    const after = census();
    expect(delta(after.unstampedPossible.grants, baseline.unstampedPossible.grants)).toBe(3);
    expect(
      delta(after.unstampedPossible.byKind.PILOT, baseline.unstampedPossible.byKind.PILOT),
    ).toBe(3);
  }, 120_000);

  it("writes nothing and prints no tenant id or slug", async () => {
    const before = await prisma.tenantFeatureOverride.count({
      where: { tenantId: { in: tenantIds } },
    });
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: dbUrl };
    const out = execFileSync("node", [CLI, "--json"], { cwd: API_DIR, encoding: "utf8", env });
    for (const id of tenantIds) expect(out).not.toContain(id);
    expect(out).not.toMatch(/qa-r640/);
    expect(
      await prisma.tenantFeatureOverride.count({ where: { tenantId: { in: tenantIds } } }),
    ).toBe(before);
  }, 120_000);
});
