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
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { FEATURE_REGISTRY } from "./feature-registry";
import { PLAN_KEYS } from "./plan-catalog.constants";
import { PlanTransitionConfigService } from "./plan-transition-config.service";
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
    // BO-13 rows (cascade does not reach customers/users through orders): delete exactly what this file made.
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
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

  it("a restore that hits a REAL Postgres error is rolled back to its savepoint and the transaction stays usable", async () => {
    const svcs = {
      snapshot: jest.fn(),
      restoreLatest: async (tx: any) => {
        // a genuine constraint failure (FK to a tenant that does not exist) — Postgres aborts the tx
        await tx.tenantFeatureConfig.create({
          data: { tenantId: "no-such-tenant", featureKey: CONFIG_KEY, mode: MODE, reason: "x" },
        });
        return null;
      },
    };
    const hook = new PlanTransitionConfigService(
      { isEnabled: async () => true } as never,
      svcs as never,
      { getVersionForTenant: async () => ({ definitions: [], addonSkus: [] }) } as never,
      { invalidate: () => undefined } as never,
      { invalidate: () => undefined } as never,
      { invalidateTenant: () => undefined } as never,
    );
    const t = { tenantId, fromPlanKey: LOW, toPlanKey: HIGH, toPlanVersionId: null };
    const prepared = await hook.prepare(t);

    const out = await prisma.$transaction(async (tx) => {
      const outcome = await hook.onPlanChange(tx, t, prepared);
      // the plan change itself still runs: a statement AFTER the failed restore succeeds
      const still = await tx.tenant.count({ where: { id: tenantId } });
      return { outcome, still };
    });

    expect(out.outcome).toEqual({ action: "restore", restore: null });
    expect(out.still).toBe(1);
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
  // ─── BO-13: the restore never crosses the billing moment under a shipment, nor writes own delivery
  // to an account with no fleet. The delivery-method row is held, everything else is restored, and
  // the snapshot stays claimable until a run completes it.
  describe("a held delivery method (BO-13)", () => {
    const FM = "fulfilment_model";

    async function reset() {
      await prisma.tenantFeatureConfigSnapshot.deleteMany({ where: { tenantId } });
      await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId } });
      await prisma.tenantFeatureConfig.deleteMany({ where: { tenantId } });
      await prisma.tenantAddon.deleteMany({ where: { tenantId } });
      await prisma.order.deleteMany({ where: { tenantId } });
    }

    /** Snapshot (delivery method = snapMode, CONFIG_KEY settings {x:1}), then drift both to the stored values. */
    async function arrange(snapMode: string, storedMode: string) {
      await reset();
      await prisma.tenantFeatureConfig.createMany({
        data: [
          { tenantId, featureKey: FM, mode: snapMode, reason: "pilot" },
          { tenantId, featureKey: CONFIG_KEY, mode: MODE, settings: { x: 1 }, reason: "pilot" },
        ],
      });
      const snap = await prisma.$transaction((tx) => svc.snapshot(tx, tenantId, HIGH, "DOWNGRADE"));
      // older than the snapshot, so the restore treats them as the downgrade-era values (not keptNewer)
      const old = new Date(Date.now() - 3_600_000);
      await prisma.tenantFeatureConfig.updateMany({
        where: { tenantId, featureKey: FM },
        data: { mode: storedMode, updatedAt: old },
      });
      await prisma.tenantFeatureConfig.updateMany({
        where: { tenantId, featureKey: CONFIG_KEY },
        data: { settings: { stale: 1 }, updatedAt: old },
      });
      return snap;
    }

    // Called more than once per run: each call needs its own customer (User_tenantId_email_key is unique).
    let shippedOrderSeq = 0;
    async function shippedOrder() {
      const n = ++shippedOrderSeq;
      const user = await prisma.user.create({
        data: {
          email: `cust-${RUN}-${n}@example.invalid`,
          username: `cust-${RUN}-${n}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: "Acme Retail", contactName: "c", tenantId },
      });
      return prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderNumber: `ORD-BO13-${RUN}`,
          fulfillPath: "SHIP",
          status: "OUT_FOR_DELIVERY",
          shippedAt: new Date(),
        },
      });
    }

    const modeOf = async (key: string) =>
      (await prisma.tenantFeatureConfig.findFirstOrThrow({ where: { tenantId, featureKey: key } }))
        .mode;

    it("a shipped-not-delivered order holds delivery -> ship: the row stays, the rest restores, the snapshot stays claimable; delivered, a second run completes it", async () => {
      const snap = await arrange("ship", "delivery");
      const order = await shippedOrder();

      const first = await prisma.$transaction((tx) =>
        svc.restoreSnapshot(tx, tenantId, snap.id, HIGH),
      );

      expect(first!.held).toEqual([
        { featureKey: FM, from: "delivery", to: "ship", reason: "CARRIER_IN_TRANSIT", count: 1 },
      ]);
      expect(first!.report.skipped).toBe(1);
      expect(await modeOf(FM)).toBe("delivery");
      expect(
        (
          await prisma.tenantFeatureConfig.findFirstOrThrow({
            where: { tenantId, featureKey: CONFIG_KEY },
          })
        ).settings,
      ).toEqual({ x: 1 });
      expect(
        (await prisma.tenantFeatureConfigSnapshot.findUniqueOrThrow({ where: { id: snap.id } }))
          .restoredAt,
      ).toBeNull();

      await prisma.order.update({ where: { id: order.id }, data: { status: "DELIVERED" } });
      const second = await prisma.$transaction((tx) =>
        svc.restoreSnapshot(tx, tenantId, snap.id, HIGH),
      );

      expect(second!.held).toEqual([]);
      expect(second!.report).toMatchObject({ restored: 1, unchanged: 1 });
      expect(await modeOf(FM)).toBe("ship");
      expect(
        (await prisma.tenantFeatureConfigSnapshot.findUniqueOrThrow({ where: { id: snap.id } }))
          .restoredAt,
      ).not.toBeNull();
    });

    it("through restoreLatest inside a plan-change transaction: the upgrade commits, the row is held, the partial run is audited on its own action", async () => {
      const snap = await arrange("ship", "delivery");
      await shippedOrder();
      const hook = new PlanTransitionConfigService(
        { isEnabled: async () => true } as never,
        svc,
        { getVersionForTenant: async () => ({ definitions: [], addonSkus: [] }) } as never,
        { invalidate: () => undefined } as never,
        { invalidate: () => undefined } as never,
        { invalidateTenant: () => undefined } as never,
      );
      const t = { tenantId, fromPlanKey: LOW, toPlanKey: HIGH, toPlanVersionId: null };

      const out = await prisma.$transaction(async (tx) => {
        const outcome = await hook.onPlanChange(tx, t, { enabled: true, planAllows: () => true });
        // the plan change's own write still runs after the held restore
        const still = await tx.tenant.count({ where: { id: tenantId } });
        return { outcome, still };
      });

      expect(out.still).toBe(1);
      expect(out.outcome).toMatchObject({
        action: "restore",
        restore: { held: [{ featureKey: FM, reason: "CARRIER_IN_TRANSIT", count: 1 }] },
      });
      expect(await modeOf(FM)).toBe("delivery");
      expect(
        (await prisma.tenantFeatureConfigSnapshot.findUniqueOrThrow({ where: { id: snap.id } }))
          .restoredAt,
      ).toBeNull();
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { tenantId, action: "CONFIG_SNAPSHOT_RESTORE_HELD" },
      });
      expect(((audit.meta as Prisma.JsonObject).report as Prisma.JsonObject).skipped).toBe(1);
      await prisma.auditLog.deleteMany({
        where: { tenantId, action: "CONFIG_SNAPSHOT_RESTORE_HELD" },
      });
    });

    it("own delivery with no fleet module is held (FULFILMENT_MODE_NEEDS_FLEET); once a fleet add-on is held, the next run applies it", async () => {
      const snap = await arrange("delivery", "ship");

      const first = await prisma.$transaction((tx) =>
        svc.restoreSnapshot(tx, tenantId, snap.id, HIGH),
      );
      expect(first!.held).toEqual([
        { featureKey: FM, from: "ship", to: "delivery", reason: "FULFILMENT_MODE_NEEDS_FLEET" },
      ]);
      expect(await modeOf(FM)).toBe("ship");
      expect(
        (await prisma.tenantFeatureConfigSnapshot.findUniqueOrThrow({ where: { id: snap.id } }))
          .restoredAt,
      ).toBeNull();

      await prisma.tenantAddon.create({
        data: { tenantId, addonKey: "recurring_routes", active: true, isComp: true },
      });
      const second = await prisma.$transaction((tx) =>
        svc.restoreSnapshot(tx, tenantId, snap.id, HIGH),
      );
      expect(second!.held).toEqual([]);
      expect(await modeOf(FM)).toBe("delivery");
    });
  });
});
