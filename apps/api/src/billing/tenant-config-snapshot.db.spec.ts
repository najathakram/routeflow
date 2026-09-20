/**
 * DB-lane spec for the entitlement snapshot/restore round trip (Lane B A2) against a REAL
 * Postgres — proves the migration's table, the jsonb payload round trip, the transaction
 * rollback (fail closed), and the restore as the DB actually sees it.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host. The tenant is a throwaway `qa-` slug
 * approved by `assertTestTenant`; `afterAll` deletes exactly the rows this file created
 * (snapshots/overrides/configs cascade with the tenant).
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { FEATURE_REGISTRY } from "./feature-registry";
import { PLAN_KEYS } from "./plan-catalog.constants";
import { TenantConfigSnapshotService } from "./tenant-config-snapshot.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const SLUG = assertTestTenant(`qa-snap-${RUN}`, "tenant-config-snapshot.db.spec.ts");
const HIGH = PLAN_KEYS[PLAN_KEYS.length - 1];
const LOW = PLAN_KEYS[0];
const configFeature = FEATURE_REGISTRY.find((f) => f.config)!;
const CONFIG_KEY = configFeature.key;
const MODE = Object.keys(configFeature.config!.modes)[0];
const PLAIN_KEY = FEATURE_REGISTRY.find((f) => !f.config)!.key;

describeDb("TenantConfigSnapshotService — real Postgres round trip", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let tenantId: string;
  const svc = new TenantConfigSnapshotService();

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantId = (await prisma.tenant.create({ data: { slug: SLUG, name: `Snapshot ${SLUG}` } })).id;
  });

  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
    await pool.end();
  });

  it("snapshot -> loss -> restore rehydrates as-was, stamps the snapshot, and a re-run is a no-op", async () => {
    await prisma.tenantFeatureConfig.create({
      data: { tenantId, featureKey: CONFIG_KEY, mode: MODE, settings: { x: 1 }, reason: "pilot" },
    });
    await prisma.tenantFeatureOverride.create({
      data: { tenantId, featureKey: PLAIN_KEY, effect: "GRANT", kind: "COMP", reason: "support" },
    });

    // Downgrade: snapshot in the same transaction as the (simulated) plan change.
    await prisma.$transaction(async (tx) => {
      await svc.snapshot(tx, tenantId, HIGH, "DOWNGRADE", { id: null, name: "spec" });
    });
    // The config later goes missing (worst case) ...
    await prisma.tenantFeatureConfig.deleteMany({ where: { tenantId } });
    await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId } });

    // ... a LOWER plan restores nothing ...
    const lower = await prisma.$transaction((tx) => svc.restoreLatest(tx, tenantId, LOW));
    expect(lower).toBeNull();

    // ... the same plan restores as-was ...
    const res = await prisma.$transaction((tx) => svc.restoreLatest(tx, tenantId, HIGH));
    expect(res?.report).toEqual({ restored: 2, skipped: 0, keptNewer: 0, unchanged: 0 });
    const cfg = await prisma.tenantFeatureConfig.findFirstOrThrow({ where: { tenantId } });
    expect(cfg).toMatchObject({ featureKey: CONFIG_KEY, mode: MODE, settings: { x: 1 } });
    expect(await prisma.tenantFeatureOverride.count({ where: { tenantId, revokedAt: null } })).toBe(
      1,
    );
    const snap = await prisma.tenantFeatureConfigSnapshot.findFirstOrThrow({ where: { tenantId } });
    expect(snap.restoredAt).not.toBeNull();
    expect(snap.restoredToPlanKey).toBe(HIGH);

    // ... and a second restore finds nothing left to restore.
    expect(await prisma.$transaction((tx) => svc.restoreLatest(tx, tenantId, HIGH))).toBeNull();
    expect(await prisma.tenantFeatureConfig.count({ where: { tenantId } })).toBe(1);
  });

  it("fails closed — a failure after the snapshot rolls the snapshot back with the plan change", async () => {
    const before = await prisma.tenantFeatureConfigSnapshot.count({ where: { tenantId } });
    await expect(
      prisma.$transaction(async (tx) => {
        await svc.snapshot(tx, tenantId, HIGH, "DOWNGRADE");
        throw new Error("plan change failed");
      }),
    ).rejects.toThrow("plan change failed");
    expect(await prisma.tenantFeatureConfigSnapshot.count({ where: { tenantId } })).toBe(before);
  });

  it("an expired-but-unrevoked override occupies the partial unique slot: restore keeps it, never throws P2002", async () => {
    // Real index: UNIQUE (tenantId, featureKey) WHERE revokedAt IS NULL.
    await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId } });
    await prisma.tenantFeatureConfigSnapshot.deleteMany({ where: { tenantId } });
    await prisma.tenantFeatureOverride.create({
      data: { tenantId, featureKey: PLAIN_KEY, effect: "GRANT", kind: "COMP", reason: "live" },
    });
    await prisma.$transaction((tx) => svc.snapshot(tx, tenantId, HIGH, "DOWNGRADE"));
    // support replaces the grant with one that has since expired, leaving it unrevoked
    await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId } });
    await prisma.tenantFeatureOverride.create({
      data: {
        tenantId,
        featureKey: PLAIN_KEY,
        effect: "GRANT",
        kind: "COMP",
        reason: "replacement",
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const res = await prisma.$transaction((tx) => svc.restoreLatest(tx, tenantId, HIGH));
    expect(res?.report.keptNewer).toBe(1);
    expect(await prisma.tenantFeatureOverride.count({ where: { tenantId } })).toBe(1);
  });

  it("createMany + skipDuplicates resolves a live-override conflict inside the statement (no P2002, tx stays usable)", async () => {
    await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId } });
    await prisma.tenantFeatureOverride.create({
      data: { tenantId, featureKey: PLAIN_KEY, effect: "GRANT", kind: "COMP", reason: "live" },
    });

    const out = await prisma.$transaction(async (tx) => {
      const res = await tx.tenantFeatureOverride.createMany({
        skipDuplicates: true,
        data: [
          { tenantId, featureKey: PLAIN_KEY, effect: "DENY", kind: "COMP", reason: "restored" },
        ],
      });
      // the transaction is NOT aborted: a further statement still runs
      const still = await tx.tenantFeatureOverride.count({ where: { tenantId, revokedAt: null } });
      return { res, still };
    });

    expect(out.res.count).toBe(0); // the real partial unique index made the insert a no-op
    expect(out.still).toBe(1);
    const row = await prisma.tenantFeatureOverride.findFirstOrThrow({ where: { tenantId } });
    expect(row.reason).toBe("live"); // the concurrent writer's row won
  });

  it("two CONCURRENT restores of the same snapshot restore exactly ONCE (real row lock, READ COMMITTED)", async () => {
    await prisma.tenantFeatureConfigSnapshot.deleteMany({ where: { tenantId } });
    await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId } });
    await prisma.tenantFeatureConfig.deleteMany({ where: { tenantId } });
    await prisma.tenantFeatureConfig.create({
      data: { tenantId, featureKey: CONFIG_KEY, mode: MODE, settings: { x: 1 }, reason: "pilot" },
    });
    await prisma.$transaction((tx) => svc.snapshot(tx, tenantId, HIGH, "DOWNGRADE"));
    await prisma.tenantFeatureConfig.deleteMany({ where: { tenantId } });

    // Two interactive transactions, started together: both read the snapshot as un-restored; the
    // second's conditional claim blocks on the first's row lock and then matches 0 rows.
    const results = await Promise.all([
      prisma.$transaction((tx) => svc.restoreLatest(tx, tenantId, HIGH)),
      prisma.$transaction((tx) => svc.restoreLatest(tx, tenantId, HIGH)),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await prisma.tenantFeatureConfig.count({ where: { tenantId } })).toBe(1);
    const snaps = await prisma.tenantFeatureConfigSnapshot.findMany({ where: { tenantId } });
    expect(snaps).toHaveLength(1);
    expect(snaps[0].restoredAt).not.toBeNull();
  });
});
