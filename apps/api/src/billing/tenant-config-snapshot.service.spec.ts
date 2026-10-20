import { Prisma } from "@prisma/client";
import { FEATURE_REGISTRY } from "./feature-registry";
import { PLAN_KEYS } from "./plan-catalog.constants";
import {
  AUTO_RESTORE_MAX_AGE_DAYS,
  AUTO_RESTORE_MAX_ROWS,
  AUTO_RESTORE_TIME_BUDGET_MS,
  RestoreBudgetExceededError,
  TenantConfigSnapshotService,
} from "./tenant-config-snapshot.service";

// Plan keys and feature keys come from the live catalog/registry (L-206), never re-typed here.
const LOW = PLAN_KEYS[0];
const MID = PLAN_KEYS[2];
const HIGH = PLAN_KEYS[PLAN_KEYS.length - 1];
const configFeature = FEATURE_REGISTRY.find((f) => f.config)!;
const CONFIG_KEY = configFeature.key;
const MODE = Object.keys(configFeature.config!.modes)[0];
const PLAIN_KEY = FEATURE_REGISTRY.find((f) => !f.config)!.key;

const TENANT = "t-1";
const T0 = new Date("2026-09-10T12:00:00.000Z");
const NOW = new Date("2026-09-20T00:00:00.000Z");

/** Minimal in-memory tx: just the four delegates the service touches. */
function fakeTx(
  seed: {
    configs?: any[];
    overrides?: any[];
    snapshots?: any[];
    /** BO-13: carrier orders in flight (what `order.count` answers). */
    inTransit?: number;
    /** BO-13: active TenantAddon keys. */
    addons?: string[];
  } = {},
) {
  const state = {
    inTransit: seed.inTransit ?? 0,
    addons: [...(seed.addons ?? [])],
    configs: [...(seed.configs ?? [])],
    overrides: [...(seed.overrides ?? [])],
    snapshots: [...(seed.snapshots ?? [])],
    seq: 0,
  };
  const id = (p: string) => `${p}${++state.seq}`;
  const tx = {
    order: { count: jest.fn(async () => state.inTransit) },
    tenantAddon: {
      findMany: jest.fn(async () => state.addons.map((addonKey) => ({ addonKey }))),
    },
    tenantFeatureConfig: {
      findMany: async () => state.configs.map((r) => ({ ...r })),
      create: async ({ data }: any) => {
        const row = { id: id("c"), updatedAt: NOW, ...data };
        state.configs.push(row);
        return row;
      },
      upsert: async ({ where, create, update }: any) => {
        const key = where.tenantId_featureKey;
        const row = state.configs.find(
          (r) => r.tenantId === key.tenantId && r.featureKey === key.featureKey,
        );
        if (row) Object.assign(row, update, { updatedAt: NOW });
        else state.configs.push({ id: id("c"), updatedAt: NOW, ...create });
      },
      updateMany: async ({ where, data }: any) => {
        const row = state.configs.find((r) => r.id === where.id && r.tenantId === where.tenantId);
        if (row) Object.assign(row, data, { updatedAt: NOW });
        return { count: row ? 1 : 0 };
      },
    },
    tenantFeatureOverride: {
      findMany: async () => state.overrides.map((r) => ({ ...r })),
      // ON CONFLICT DO NOTHING: a live (unrevoked) row for the same feature wins, ours is skipped.
      createMany: async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const d of data) {
          const live = state.overrides.some(
            (o) =>
              o.tenantId === d.tenantId && o.featureKey === d.featureKey && o.revokedAt === null,
          );
          if (live) {
            if (!skipDuplicates) throw new Error("P2002 unique violation");
            continue;
          }
          state.overrides.push({ id: id("o"), createdAt: NOW, revokedAt: null, ...d });
          count++;
        }
        return { count };
      },
    },
    tenantFeatureConfigSnapshot: {
      // Applies the query's real `where`: `restoredAt: null` only when the caller asks for it.
      findMany: async ({ where }: any) =>
        state.snapshots
          .filter(
            (s) =>
              s.tenantId === where.tenantId &&
              (where.restoredAt === undefined || s.restoredAt === where.restoredAt) &&
              (where.reason === undefined || s.reason === where.reason),
          )
          .sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime()),
      findFirst: async ({ where }: any) =>
        state.snapshots.find(
          (s) =>
            s.id === where.id &&
            s.tenantId === where.tenantId &&
            (where.restoredAt === undefined || s.restoredAt === where.restoredAt),
        ) ?? null,
      create: async ({ data }: any) => {
        const row = { id: id("s"), restoredAt: null, restoredToPlanKey: null, ...data };
        state.snapshots.push(row);
        return { id: row.id, takenAt: row.takenAt };
      },
      update: async ({ where, data }: any) => {
        Object.assign(
          state.snapshots.find((s) => s.id === where.id),
          data,
        );
      },
      updateMany: async ({ where, data }: any) => {
        if (where.id) {
          // the restore's CLAIM: a conditional stamp, `restoredAt IS NULL` (only one caller wins)
          const row = state.snapshots.find(
            (s) =>
              s.id === where.id &&
              s.tenantId === where.tenantId &&
              s.restoredAt === where.restoredAt,
          );
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }
        const rows = state.snapshots.filter(
          (s) =>
            s.tenantId === where.tenantId &&
            s.restoredAt === null &&
            (where.reason === undefined || s.reason === where.reason) &&
            s.takenAt.getTime() < where.takenAt.lt.getTime(),
        );
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, state };
}

const cfgRow = (over: any = {}) => ({
  id: "c0",
  tenantId: TENANT,
  featureKey: CONFIG_KEY,
  mode: MODE,
  settings: { x: 1 },
  reason: "pilot",
  updatedById: "u1",
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  ...over,
});
const ovrRow = (over: any = {}) => ({
  id: "o0",
  tenantId: TENANT,
  featureKey: PLAIN_KEY,
  effect: "GRANT",
  kind: "COMP",
  reason: "support",
  expiresAt: null,
  createdById: "u1",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  revokedAt: null,
  ...over,
});

describe("TenantConfigSnapshotService.snapshot", () => {
  const svc = new TenantConfigSnapshotService();

  it("writes exactly one snapshot against the plan being LEFT and never touches the config rows", async () => {
    const { tx, state } = fakeTx({ configs: [cfgRow()], overrides: [ovrRow()] });
    const res = await svc.snapshot(
      tx,
      TENANT,
      HIGH,
      "DOWNGRADE",
      { id: "admin1", name: "Ada" },
      T0,
    );

    expect(state.snapshots).toHaveLength(1);
    expect(state.snapshots[0]).toMatchObject({
      tenantId: TENANT,
      planKey: HIGH,
      reason: "DOWNGRADE",
      createdById: "admin1",
      createdByName: "Ada",
    });
    expect(res.takenAt).toEqual(T0);
    expect(state.snapshots[0].payload.configs).toHaveLength(1);
    expect(state.snapshots[0].payload.overrides).toHaveLength(1);
    // Never hard-deletes or edits: the downgrade makes rows inert, they stay.
    expect(state.configs).toHaveLength(1);
    expect(state.overrides).toHaveLength(1);
  });

  it("fails closed — a snapshot-write failure rejects, so the caller's transaction aborts the downgrade", async () => {
    const { tx } = fakeTx({ configs: [cfgRow()] });
    (tx as any).tenantFeatureConfigSnapshot.create = async () => {
      throw new Error("db down");
    };
    await expect(svc.snapshot(tx, TENANT, HIGH, "DOWNGRADE", undefined, T0)).rejects.toThrow(
      "db down",
    );
  });
});

describe("TenantConfigSnapshotService.restoreLatest", () => {
  const svc = new TenantConfigSnapshotService();

  async function downgradedTenant() {
    // Tenant on HIGH with config + a grant; downgrade snapshots then the rows go inert-but-present.
    const { tx, state } = fakeTx({ configs: [cfgRow()], overrides: [ovrRow()] });
    await svc.snapshot(tx, TENANT, HIGH, "DOWNGRADE", undefined, T0);
    return { tx, state };
  }

  it("restores as-was on re-upgrade to the same plan, stamps the snapshot, and reports counts", async () => {
    const { tx, state } = fakeTx();
    // Rows were lost/reset after the downgrade (worst case): seed a snapshot with a payload.
    const seeded = fakeTx({ configs: [cfgRow()], overrides: [ovrRow()] });
    await svc.snapshot(seeded.tx, TENANT, HIGH, "DOWNGRADE", undefined, T0);
    state.snapshots.push(...seeded.state.snapshots);

    const res = await svc.restoreLatest(tx, TENANT, HIGH, NOW);

    expect(res).not.toBeNull();
    expect(res!.report).toEqual({ restored: 2, skipped: 0, keptNewer: 0, unchanged: 0 });
    expect(state.configs).toHaveLength(1);
    expect(state.configs[0]).toMatchObject({
      featureKey: CONFIG_KEY,
      mode: MODE,
      settings: { x: 1 },
    });
    expect(state.overrides).toHaveLength(1);
    expect(state.snapshots[0]).toMatchObject({ restoredAt: NOW, restoredToPlanKey: HIGH });
  });

  it("is idempotent — a second restore finds no un-restored snapshot and changes nothing", async () => {
    const { tx, state } = fakeTx();
    const seeded = fakeTx({ configs: [cfgRow()], overrides: [ovrRow()] });
    await svc.snapshot(seeded.tx, TENANT, HIGH, "DOWNGRADE", undefined, T0);
    state.snapshots.push(...seeded.state.snapshots);

    await svc.restoreLatest(tx, TENANT, HIGH, NOW);
    const before = JSON.stringify([state.configs, state.overrides]);
    const again = await svc.restoreLatest(tx, TENANT, HIGH, NOW);

    expect(again).toBeNull();
    expect(JSON.stringify([state.configs, state.overrides])).toBe(before);
  });

  it("a plan LOWER than the snapshot's never restores", async () => {
    const { tx, state } = await downgradedTenant();
    expect(await svc.restoreLatest(tx, TENANT, MID, NOW)).toBeNull();
    expect(await svc.restoreLatest(tx, TENANT, LOW, NOW)).toBeNull();
    expect(state.snapshots[0].restoredAt).toBeNull();
  });

  it("an upgrade to a HIGHER plan than the snapshot's restores it", async () => {
    const { tx, state } = fakeTx();
    const seeded = fakeTx({ configs: [cfgRow()] });
    await svc.snapshot(seeded.tx, TENANT, MID, "DOWNGRADE", undefined, T0);
    state.snapshots.push(...seeded.state.snapshots);
    const res = await svc.restoreLatest(tx, TENANT, HIGH, NOW);
    expect(res?.planKey).toBe(MID);
    expect(state.configs).toHaveLength(1);
  });

  it("a newer manual change made AFTER the downgrade survives the restore and is reported", async () => {
    const { tx, state } = fakeTx({
      configs: [cfgRow({ mode: "manual_change", updatedAt: new Date("2026-09-15T00:00:00.000Z") })],
    });
    const seeded = fakeTx({ configs: [cfgRow()] });
    await svc.snapshot(seeded.tx, TENANT, HIGH, "DOWNGRADE", undefined, T0);
    state.snapshots.push(...seeded.state.snapshots);

    const res = await svc.restoreLatest(tx, TENANT, HIGH, NOW);
    expect(res!.report.keptNewer).toBe(1);
    expect(state.configs[0].mode).toBe("manual_change");
  });

  it("restores an as-was NULL settings value with DbNull, not 'leave unchanged'", async () => {
    const { tx, state } = fakeTx({
      configs: [
        cfgRow({ settings: { stale: true }, updatedAt: new Date("2026-09-01T00:00:00.000Z") }),
      ],
    });
    const seeded = fakeTx({ configs: [cfgRow({ settings: null })] });
    await svc.snapshot(seeded.tx, TENANT, HIGH, "DOWNGRADE", undefined, T0);
    state.snapshots.push(...seeded.state.snapshots);

    await svc.restoreLatest(tx, TENANT, HIGH, NOW);
    expect(state.configs[0].settings).toBe(Prisma.DbNull);
  });

  it("returns null for an unknown plan key (never restores on a guess)", async () => {
    const { tx } = await downgradedTenant();
    expect(await svc.restoreLatest(tx, TENANT, "NOT_A_PLAN", NOW)).toBeNull();
  });

  it("supersedes OLDER un-restored snapshots so a later upgrade cannot re-apply a stale payload", async () => {
    const { tx, state } = fakeTx();
    const older = fakeTx({ configs: [cfgRow({ settings: { old: true } })] });
    await svc.snapshot(
      older.tx,
      TENANT,
      HIGH,
      "DOWNGRADE",
      undefined,
      new Date("2026-09-05T00:00:00.000Z"),
    );
    const newer = fakeTx({ configs: [cfgRow()] });
    await svc.snapshot(newer.tx, TENANT, MID, "DOWNGRADE", undefined, T0);
    // each fakeTx mints its own ids ("s1"…) — make them distinct before merging the two stores
    older.state.snapshots[0].id = "s-old";
    newer.state.snapshots[0].id = "s-new";
    state.snapshots.push(...older.state.snapshots, ...newer.state.snapshots);

    const res = await svc.restoreLatest(tx, TENANT, HIGH, NOW);
    expect(res?.planKey).toBe(MID); // the NEWEST eligible one
    const stamped = state.snapshots.map((s) => [s.planKey, s.restoredToPlanKey]);
    expect(stamped).toContainEqual([MID, HIGH]);
    expect(stamped).toContainEqual([HIGH, "SUPERSEDED"]);
    // a later re-upgrade finds nothing left to restore
    expect(await svc.restoreLatest(tx, TENANT, HIGH, NOW)).toBeNull();
  });

  it("a malformed / future-version payload never throws and is left un-stamped", async () => {
    const { tx, state } = fakeTx({
      snapshots: [
        {
          id: "sx",
          tenantId: TENANT,
          planKey: HIGH,
          takenAt: T0,
          restoredAt: null,
          restoredToPlanKey: null,
          payload: { version: 99, configs: [], overrides: [] },
        },
      ],
    });
    await expect(svc.restoreLatest(tx, TENANT, HIGH, NOW)).resolves.toBeNull();
    expect(state.snapshots[0].restoredAt).toBeNull();
    expect(state.configs).toHaveLength(0);
  });

  it("passes the plan's allow-list through: a not-allowed entry is skipped and reported", async () => {
    const { tx, state } = fakeTx();
    const seeded = fakeTx({ configs: [cfgRow()], overrides: [ovrRow()] });
    await svc.snapshot(seeded.tx, TENANT, HIGH, "DOWNGRADE", undefined, T0);
    state.snapshots.push(...seeded.state.snapshots);

    const res = await svc.restoreLatest(tx, TENANT, HIGH, NOW, (k) => k !== CONFIG_KEY);
    expect(res!.report).toEqual({ restored: 1, skipped: 1, keptNewer: 0, unchanged: 0 });
    expect(state.configs).toHaveLength(0);
    expect(state.overrides).toHaveLength(1);
  });
});

describe("TenantConfigSnapshotService — admin surface (A2 step c)", () => {
  const svc = new TenantConfigSnapshotService();

  async function twoSnapshots() {
    // Older snapshot on MID, newer on HIGH; both un-restored, each with its own payload.
    const { tx, state } = fakeTx({ configs: [cfgRow()], overrides: [ovrRow()] });
    await svc.snapshot(tx, TENANT, PLAN_KEYS[1], "DOWNGRADE", { id: "u1", name: "Ann" }, T0);
    await svc.snapshot(tx, TENANT, HIGH, "MANUAL", undefined, new Date(T0.getTime() + 86_400_000));
    return { tx, state };
  }

  it("list() returns every snapshot newest-first with entry counts, restored ones included", async () => {
    const { tx, state } = await twoSnapshots();
    state.snapshots[0].restoredAt = NOW;
    state.snapshots[0].restoredToPlanKey = "SUPERSEDED";

    const rows = await svc.list(tx, TENANT);

    expect(rows.map((r) => [r.planKey, r.reason])).toEqual([
      [HIGH, "MANUAL"],
      [PLAN_KEYS[1], "DOWNGRADE"],
    ]);
    expect(rows[1]).toMatchObject({
      restoredAt: NOW,
      restoredToPlanKey: "SUPERSEDED",
      createdByName: "Ann",
      entries: { configs: 1, overrides: 1 },
    });
  });

  it("list() reports entries: null for an unreadable payload instead of throwing", async () => {
    const { tx, state } = await twoSnapshots();
    state.snapshots[0].payload = { version: 99 };

    const rows = await svc.list(tx, TENANT);

    expect(rows.find((r) => r.planKey === PLAN_KEYS[1])!.entries).toBeNull();
  });

  it("previewRestore() shows what a restore would do and writes NOTHING", async () => {
    const { tx, state } = await twoSnapshots();
    state.configs.length = 0; // the config went missing
    const before = JSON.stringify(state);

    const preview = await svc.previewRestore(tx, TENANT, state.snapshots[1].id, NOW);

    expect(preview?.plan?.configs.create).toHaveLength(1);
    expect(preview?.plan?.overrides.unchanged).toHaveLength(1); // the grant is still live
    expect(JSON.stringify(state)).toBe(before);
  });

  it("previewRestore() and restoreSnapshot() never see another tenant's snapshot", async () => {
    const { tx, state } = await twoSnapshots();
    const id = state.snapshots[0].id;

    expect(await svc.previewRestore(tx, "other-tenant", id, NOW)).toBeNull();
    expect(await svc.restoreSnapshot(tx, "other-tenant", id, HIGH, NOW)).toBeNull();
    expect(state.snapshots.every((s) => s.restoredAt === null)).toBe(true);
  });

  it("restoreSnapshot() restores the CHOSEN snapshot to the current plan, stamps it, supersedes older ones", async () => {
    const { tx, state } = await twoSnapshots();
    state.configs.length = 0;
    const newest = state.snapshots[1];

    const res = await svc.restoreSnapshot(tx, TENANT, newest.id, MID, NOW);

    expect(res?.snapshotId).toBe(newest.id);
    expect(res?.report.restored).toBeGreaterThan(0);
    expect(newest.restoredAt).toBe(NOW);
    expect(newest.restoredToPlanKey).toBe(MID); // stamped with the CURRENT plan, not the snapshot's
    expect(state.snapshots[0].restoredToPlanKey).toBe("SUPERSEDED");
    expect(state.configs).toHaveLength(1);
  });

  it("restoreSnapshot() applies to a plan LOWER than the snapshot's (the admin saw the preview) and honours planAllows", async () => {
    const { tx, state } = await twoSnapshots();
    state.configs.length = 0;

    const res = await svc.restoreSnapshot(tx, TENANT, state.snapshots[1].id, LOW, NOW, () => false);

    expect(res?.report.skipped).toBeGreaterThan(0);
    expect(state.configs).toHaveLength(0); // the plan allows nothing -> nothing restored
  });

  it("restoreSnapshot() refuses an already-restored snapshot (null)", async () => {
    const { tx, state } = await twoSnapshots();
    state.snapshots[1].restoredAt = NOW;

    expect(await svc.restoreSnapshot(tx, TENANT, state.snapshots[1].id, HIGH, NOW)).toBeNull();
  });
});

describe("TenantConfigSnapshotService — 90-day automatic-restore horizon (A2 decision 1)", () => {
  const svc = new TenantConfigSnapshotService();
  const daysAgo = (n: number, ms = 0) => new Date(NOW.getTime() - n * 86_400_000 - ms);

  /** A tenant on HIGH that was snapshotted `days` before NOW, then lost its config. */
  async function snapshottedAgo(days: number, extraMs = 0) {
    const { tx, state } = fakeTx({ configs: [cfgRow()], overrides: [ovrRow()] });
    await svc.snapshot(tx, TENANT, HIGH, "DOWNGRADE", undefined, daysAgo(days, extraMs));
    state.configs.length = 0;
    return { tx, state };
  }

  it("pins the horizon at 90 days", () => expect(AUTO_RESTORE_MAX_AGE_DAYS).toBe(90));

  it("a re-upgrade restores a snapshot 89 days old", async () => {
    const { tx, state } = await snapshottedAgo(89);
    expect(await svc.restoreLatest(tx, TENANT, HIGH, NOW)).not.toBeNull();
    expect(state.configs).toHaveLength(1);
  });

  it("the boundary is inclusive: exactly 90 days old still restores", async () => {
    const { tx } = await snapshottedAgo(90);
    expect(await svc.restoreLatest(tx, TENANT, HIGH, NOW)).not.toBeNull();
  });

  it("a snapshot 91 days old is NOT restored automatically, and stays un-stamped", async () => {
    const { tx, state } = await snapshottedAgo(91);

    expect(await svc.restoreLatest(tx, TENANT, HIGH, NOW)).toBeNull();
    expect(state.configs).toHaveLength(0);
    expect(state.snapshots[0].restoredAt).toBeNull();
  });

  it("one millisecond past 90 days is refused (no rounding in the tenant's favour)", async () => {
    const { tx } = await snapshottedAgo(90, 1);
    expect(await svc.restoreLatest(tx, TENANT, HIGH, NOW)).toBeNull();
  });

  it("restoreLatest reports how many older snapshots it superseded", async () => {
    const { tx, state } = fakeTx({ configs: [cfgRow()] });
    await svc.snapshot(tx, TENANT, HIGH, "DOWNGRADE", undefined, daysAgo(20));
    await svc.snapshot(tx, TENANT, HIGH, "DOWNGRADE", undefined, daysAgo(10));
    state.configs.length = 0;

    const res = await svc.restoreLatest(tx, TENANT, HIGH, NOW);

    expect(res?.supersededSnapshots).toBe(1);
  });
});

describe("TenantConfigSnapshotService — a concurrent live override never aborts the restore (P2002)", () => {
  const svc = new TenantConfigSnapshotService();

  it("restores overrides with ONE createMany + skipDuplicates (ON CONFLICT DO NOTHING), not a create per row", async () => {
    const { tx, state } = fakeTx({ overrides: [ovrRow()] });
    await svc.snapshot(tx, TENANT, HIGH, "DOWNGRADE", undefined, T0);
    state.overrides.length = 0;
    const spy = jest.spyOn(tx.tenantFeatureOverride as any, "createMany");

    await svc.restoreLatest(tx, TENANT, HIGH, NOW);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ skipDuplicates: true });
    expect(state.overrides).toHaveLength(1);
  });

  it("a live override that appears between the plan and the write wins and the restore still completes", async () => {
    const { tx, state } = fakeTx({ overrides: [ovrRow()] });
    await svc.snapshot(tx, TENANT, HIGH, "DOWNGRADE", undefined, T0);
    state.overrides.length = 0; // the plan will see "no override" ...
    const real = (tx.tenantFeatureOverride as any).createMany;
    (tx.tenantFeatureOverride as any).createMany = async (args: any) => {
      // ... and an admin grants the same feature just before the insert lands
      state.overrides.push({ ...ovrRow({ id: "raced", reason: "admin" }) });
      return real(args);
    };

    const res = await svc.restoreLatest(tx, TENANT, HIGH, NOW);

    expect(res).not.toBeNull(); // did not throw
    expect(state.overrides).toHaveLength(1);
    expect(state.overrides[0].id).toBe("raced"); // the concurrent writer's row wins
    expect(state.snapshots[0].restoredAt).not.toBeNull();
  });
});

describe("TenantConfigSnapshotService — restore reports honestly and only consumes DOWNGRADE archives", () => {
  const svc = new TenantConfigSnapshotService();

  it("(d) a MANUAL snapshot is never auto-consumed by a re-upgrade", async () => {
    const { tx, state } = fakeTx({ configs: [cfgRow()] });
    await svc.snapshot(tx, TENANT, HIGH, "MANUAL", undefined, T0);
    state.configs.length = 0;

    expect(await svc.restoreLatest(tx, TENANT, HIGH, NOW)).toBeNull();
    expect(state.configs).toHaveLength(0);
    expect(state.snapshots[0].restoredAt).toBeNull();
  });

  it("(d) with both kinds present, only the DOWNGRADE archive is consumed", async () => {
    const { tx, state } = fakeTx({ configs: [cfgRow()] });
    await svc.snapshot(tx, TENANT, HIGH, "DOWNGRADE", undefined, T0);
    await svc.snapshot(tx, TENANT, HIGH, "MANUAL", undefined, new Date(T0.getTime() + 1000));
    state.configs.length = 0;

    const res = await svc.restoreLatest(tx, TENANT, HIGH, NOW);

    expect(res?.snapshotId).toBe(state.snapshots[0].id); // the DOWNGRADE one, though older
    expect(state.snapshots[1].restoredAt).toBeNull();
  });

  it("(d) a MANUAL snapshot OLDER than the restored DOWNGRADE one is not superseded either", async () => {
    const { tx, state } = fakeTx({ configs: [cfgRow()] });
    await svc.snapshot(tx, TENANT, HIGH, "MANUAL", undefined, T0);
    await svc.snapshot(tx, TENANT, HIGH, "DOWNGRADE", undefined, new Date(T0.getTime() + 1000));
    state.configs.length = 0;

    const res = await svc.restoreLatest(tx, TENANT, HIGH, NOW);

    expect(res?.snapshotId).toBe(state.snapshots[1].id);
    expect(res?.supersededSnapshots).toBe(0);
    expect(state.snapshots[0].restoredAt).toBeNull(); // the admin's save-point survives
  });

  it("(a) an override the statement SKIPPED (a live one won the race) is reported as kept, not restored", async () => {
    const { tx, state } = fakeTx({ overrides: [ovrRow()] });
    await svc.snapshot(tx, TENANT, HIGH, "DOWNGRADE", undefined, T0);
    state.overrides.length = 0;
    const real = (tx.tenantFeatureOverride as any).createMany;
    (tx.tenantFeatureOverride as any).createMany = async (args: any) => {
      state.overrides.push({ ...ovrRow({ id: "raced" }) }); // an admin grant lands just before the insert
      return real(args);
    };

    const res = await svc.restoreLatest(tx, TENANT, HIGH, NOW);

    expect(res?.report).toEqual({ restored: 0, skipped: 0, keptNewer: 1, unchanged: 0 });
  });
});

describe("TenantConfigSnapshotService — the automatic restore is bounded (row cap + time budget)", () => {
  const svc = new TenantConfigSnapshotService();

  async function twoRowSnapshot() {
    const seeded = fakeTx({ configs: [cfgRow()], overrides: [ovrRow()] });
    await svc.snapshot(seeded.tx, TENANT, HIGH, "DOWNGRADE", undefined, T0);
    const { tx, state } = fakeTx();
    state.snapshots.push(...seeded.state.snapshots);
    return { tx, state };
  }

  it("the defaults are finite and sane", () => {
    expect(AUTO_RESTORE_MAX_ROWS).toBeGreaterThan(0);
    expect(AUTO_RESTORE_MAX_ROWS).toBeLessThanOrEqual(1000);
    expect(AUTO_RESTORE_TIME_BUDGET_MS).toBeGreaterThan(0);
    expect(AUTO_RESTORE_TIME_BUDGET_MS).toBeLessThanOrEqual(3_000); // inside the checkout tx's 6 s with room to spare
  });

  it("only the AUTOMATIC path is bounded: restoreLatest passes bounds to applySnapshot, the admin restoreSnapshot passes none", async () => {
    const { tx, state } = await twoRowSnapshot();
    const spy = jest.spyOn(svc as any, "applySnapshot");

    await svc.restoreLatest(tx, TENANT, HIGH, NOW);
    expect(spy.mock.calls[0][6]).toMatchObject({ maxRows: AUTO_RESTORE_MAX_ROWS });
    expect(typeof (spy.mock.calls[0][6] as any).withinBudget).toBe("function");

    // Same snapshot, restored explicitly by an admin: no bounds at all.
    state.snapshots[0].restoredAt = null;
    await svc.restoreSnapshot(tx, TENANT, state.snapshots[0].id, HIGH, NOW);
    expect(spy.mock.calls[1][6]).toBeUndefined();
    spy.mockRestore();
  });

  it("a restore over the row cap is refused BEFORE any write and leaves the snapshot un-restored", async () => {
    const { tx, state } = await twoRowSnapshot();

    await expect(
      svc.restoreLatest(tx, TENANT, HIGH, NOW, undefined, { maxRows: 1, timeBudgetMs: 60_000 }),
    ).rejects.toBeInstanceOf(RestoreBudgetExceededError);

    expect(state.configs).toHaveLength(0);
    expect(state.overrides).toHaveLength(0);
    expect(state.snapshots[0].restoredAt).toBeNull(); // still there for an explicit "Restore now"
  });

  it("exactly at the cap is allowed", async () => {
    const { tx, state } = await twoRowSnapshot();
    const res = await svc.restoreLatest(tx, TENANT, HIGH, NOW, undefined, {
      maxRows: 2,
      timeBudgetMs: 60_000,
    });
    expect(res?.report.restored).toBe(2);
    expect(state.snapshots[0].restoredAt).not.toBeNull();
  });

  it("a restore that outlives its time budget is abandoned mid-way with the typed error (the caller's savepoint undoes it)", async () => {
    const { tx, state } = await twoRowSnapshot();
    let t = 0;
    const clock = () => (t += 5_000); // every look at the clock costs 5 s

    await expect(
      svc.restoreLatest(tx, TENANT, HIGH, NOW, undefined, {
        maxRows: 100,
        timeBudgetMs: 1_000,
        clock,
      }),
    ).rejects.toBeInstanceOf(RestoreBudgetExceededError);

    expect(state.snapshots[0].restoredAt).toBeNull();
  });
});

describe("TenantConfigSnapshotService — two concurrent restores restore ONCE (review F7)", () => {
  const svc = new TenantConfigSnapshotService();

  it("the loser of a race returns null: no second restore, no second stamp, no double write", async () => {
    const { tx, state } = fakeTx({ configs: [cfgRow()], overrides: [ovrRow()] });
    await svc.snapshot(tx, TENANT, HIGH, "DOWNGRADE", undefined, T0);
    state.configs.length = 0;
    state.overrides.length = 0;
    const snap = state.snapshots[0];
    const staleRead = { ...snap }; // what the second transaction read BEFORE the first committed

    const first = await svc.restoreLatest(tx, TENANT, HIGH, NOW);
    expect(first).not.toBeNull();
    const writesAfterFirst = JSON.stringify([state.configs, state.overrides]);

    // the second transaction still believes the snapshot is un-restored ...
    const findMany = (tx.tenantFeatureConfigSnapshot as any).findMany;
    (tx.tenantFeatureConfigSnapshot as any).findMany = async () => [staleRead];
    const second = await svc.restoreLatest(tx, TENANT, HIGH, new Date(NOW.getTime() + 1000));
    (tx.tenantFeatureConfigSnapshot as any).findMany = findMany;

    // ... but its conditional claim matches 0 rows
    expect(second).toBeNull();
    expect(JSON.stringify([state.configs, state.overrides])).toBe(writesAfterFirst);
    expect(snap.restoredAt).toEqual(NOW); // the FIRST restore's stamp, untouched
  });

  it("a manual restore racing an already-claimed snapshot is also a no-op (double-click)", async () => {
    const { tx, state } = fakeTx({ configs: [cfgRow()] });
    await svc.snapshot(tx, TENANT, HIGH, "DOWNGRADE", undefined, T0);
    state.configs.length = 0;
    const id = state.snapshots[0].id;
    (tx.tenantFeatureConfigSnapshot as any).findFirst = async () => ({
      ...state.snapshots[0],
      restoredAt: null,
    });

    expect(await svc.restoreSnapshot(tx, TENANT, id, HIGH, NOW)).not.toBeNull();
    expect(await svc.restoreSnapshot(tx, TENANT, id, HIGH, NOW)).toBeNull();
  });
});

describe("TenantConfigSnapshotService — ages in list() and previewRestore()", () => {
  const svc = new TenantConfigSnapshotService();
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  it("previewRestore() reports the age and whether it is beyond the automatic-restore horizon", async () => {
    const { tx, state } = fakeTx({ configs: [cfgRow()] });
    await svc.snapshot(tx, TENANT, HIGH, "DOWNGRADE", undefined, daysAgo(91));
    await svc.snapshot(tx, TENANT, HIGH, "MANUAL", undefined, daysAgo(10));

    const old = await svc.previewRestore(tx, TENANT, state.snapshots[0].id, NOW);
    const fresh = await svc.previewRestore(tx, TENANT, state.snapshots[1].id, NOW);

    expect(old).toMatchObject({ ageDays: 91, beyondAutoRestoreHorizon: true });
    expect(fresh).toMatchObject({ ageDays: 10, beyondAutoRestoreHorizon: false });
  });

  it("list() carries a whole-day age per row", async () => {
    const { tx } = fakeTx({ configs: [cfgRow()] });
    await svc.snapshot(
      tx,
      TENANT,
      HIGH,
      "DOWNGRADE",
      undefined,
      new Date(Date.now() - 3 * 86_400_000 - 1000),
    );

    const rows = await svc.list(tx, TENANT);

    expect(rows[0].ageDays).toBe(3);
  });
});

// ─── BO-13: the restore never crosses the billing moment under a shipment, nor writes own delivery
// to an account with no fleet. The held row is skipped; the rest of the restore proceeds; the
// snapshot stays CLAIMABLE (not stamped, older ones not superseded) so Restore Now can finish it.
describe("TenantConfigSnapshotService — held fulfilment_model (BO-13)", () => {
  const svc = new TenantConfigSnapshotService();
  const FM = "fulfilment_model";
  const FLEET = "order_delivery";
  const fmRow = (mode: string, over: any = {}) =>
    cfgRow({ id: "c-fm", featureKey: FM, mode, settings: null, ...over });

  /** A DOWNGRADE snapshot of `rows` (+ overrides), seeded into `target`'s store. */
  async function seedSnapshot(
    target: ReturnType<typeof fakeTx>,
    rows: any[],
    overrides: any[] = [],
    at: Date = T0,
    planKey: string = HIGH,
  ) {
    const src = fakeTx({ configs: rows, overrides });
    await svc.snapshot(src.tx, TENANT, planKey, "DOWNGRADE", undefined, at);
    src.state.snapshots[0].id = `snap-${target.state.snapshots.length + 1}`;
    target.state.snapshots.push(...src.state.snapshots);
    return src.state.snapshots[0].id as string;
  }

  it("CARRIER_IN_TRANSIT: stored delivery, snapshot ship, 2 orders with the carrier -> the row is not written, the rest is, held reports the count, the snapshot is NOT stamped", async () => {
    const t = fakeTx({
      configs: [fmRow("delivery"), cfgRow({ settings: { stale: 1 } })],
      inTransit: 2,
    });
    const id = await seedSnapshot(t, [fmRow("ship"), cfgRow()]);

    const res = await svc.restoreSnapshot(t.tx, TENANT, id, HIGH, NOW);

    expect(res!.held).toEqual([
      { featureKey: FM, from: "delivery", to: "ship", reason: "CARRIER_IN_TRANSIT", count: 2 },
    ]);
    expect(t.state.configs.find((c) => c.featureKey === FM)!.mode).toBe("delivery");
    expect(t.state.configs.find((c) => c.featureKey === CONFIG_KEY)!.settings).toEqual({ x: 1 });
    expect(res!.report).toMatchObject({ restored: 1, skipped: 1 });
    expect(t.state.snapshots[0].restoredAt).toBeNull();
    expect(t.state.snapshots[0].restoredToPlanKey).toBeNull();
    expect(res!.supersededSnapshots).toBe(0);
  });

  it("a held snapshot supersedes NO older snapshot (it is still claimable, the older ones wait behind it)", async () => {
    const t = fakeTx({ configs: [fmRow("delivery")], inTransit: 1 });
    const older = await seedSnapshot(t, [cfgRow()], [], new Date("2026-09-05T00:00:00.000Z"));
    const newer = await seedSnapshot(t, [fmRow("ship")]);

    const res = await svc.restoreSnapshot(t.tx, TENANT, newer, HIGH, NOW);

    expect(res!.supersededSnapshots).toBe(0);
    expect(t.state.snapshots.find((s) => s.id === older)!.restoredAt).toBeNull();
    expect(t.state.snapshots.find((s) => s.id === newer)!.restoredAt).toBeNull();
  });

  it("no crossing, no query: ship -> both keeps the billing moment, so order.count is never called and the row is written", async () => {
    const t = fakeTx({ configs: [fmRow("ship")], inTransit: 5 });
    const id = await seedSnapshot(t, [fmRow("both")]);
    // both needs a fleet; this test is about the in-transit query only
    t.state.addons.push(FLEET);

    const res = await svc.restoreSnapshot(t.tx, TENANT, id, HIGH, NOW);

    expect(t.tx.order.count).not.toHaveBeenCalled();
    expect(res!.held).toEqual([]);
    expect(t.state.configs[0].mode).toBe("both");
    expect(t.state.snapshots[0].restoredAt).toEqual(NOW);
  });

  it("a crossing delivery -> both IS checked (both ships): in-transit orders hold it", async () => {
    const t = fakeTx({ configs: [fmRow("delivery")], inTransit: 1, addons: [FLEET] });
    const id = await seedSnapshot(t, [fmRow("both")]);
    const res = await svc.restoreSnapshot(t.tx, TENANT, id, HIGH, NOW);
    expect(res!.held).toMatchObject([
      { from: "delivery", to: "both", reason: "CARRIER_IN_TRANSIT", count: 1 },
    ]);
  });

  it("a CREATE (no stored row) is judged from the registry fallback: unset -> ship is a crossing", async () => {
    const t = fakeTx({ inTransit: 3 });
    const id = await seedSnapshot(t, [fmRow("ship")]);
    // `unset` is not a shipping mode, ship is: crosses
    const res = await svc.restoreSnapshot(t.tx, TENANT, id, HIGH, NOW);
    expect(res!.held).toMatchObject([
      { from: "unset", to: "ship", reason: "CARRIER_IN_TRANSIT", count: 3 },
    ]);
    expect(t.state.configs).toHaveLength(0);
  });

  it("zero orders in transit: the row is written and the snapshot is stamped as before", async () => {
    const t = fakeTx({ configs: [fmRow("delivery")], inTransit: 0 });
    const id = await seedSnapshot(t, [fmRow("ship")]);
    const res = await svc.restoreSnapshot(t.tx, TENANT, id, HIGH, NOW);
    expect(res!.held).toEqual([]);
    expect(t.state.configs[0].mode).toBe("ship");
    expect(t.state.snapshots[0].restoredAt).toEqual(NOW);
  });

  it("FULFILMENT_MODE_NEEDS_FLEET: snapshot `delivery` on an account with no fleet -> the row is skipped and reported, the rest is written", async () => {
    const t = fakeTx({ configs: [fmRow("ship"), cfgRow({ settings: { stale: 1 } })] });
    const id = await seedSnapshot(t, [fmRow("delivery"), cfgRow()]);

    const res = await svc.restoreSnapshot(t.tx, TENANT, id, HIGH, NOW);

    expect(res!.held).toEqual([
      { featureKey: FM, from: "ship", to: "delivery", reason: "FULFILMENT_MODE_NEEDS_FLEET" },
    ]);
    expect(t.state.configs.find((c) => c.featureKey === FM)!.mode).toBe("ship");
    expect(t.state.configs.find((c) => c.featureKey === CONFIG_KEY)!.settings).toEqual({ x: 1 });
    expect(res!.report).toMatchObject({ restored: 1, skipped: 1 });
    expect(t.state.snapshots[0].restoredAt).toBeNull();
  });

  it("the fleet check sees the restore's OWN override plan: a restored GRANT of a fleet key lets `delivery` through", async () => {
    const t = fakeTx({ configs: [fmRow("ship")] });
    const id = await seedSnapshot(
      t,
      [fmRow("delivery")],
      [ovrRow({ featureKey: FLEET, id: "o-fleet" })],
    );
    const res = await svc.restoreSnapshot(t.tx, TENANT, id, HIGH, NOW);
    expect(res!.held).toEqual([]);
    expect(t.state.configs[0].mode).toBe("delivery");
    expect(t.state.overrides.map((o) => o.featureKey)).toContain(FLEET);
  });

  it("an active fleet add-on row lets `delivery` through; a live DENY override takes it away again", async () => {
    const held = fakeTx({ configs: [fmRow("ship")], addons: [FLEET] });
    const id1 = await seedSnapshot(held, [fmRow("delivery")]);
    expect((await svc.restoreSnapshot(held.tx, TENANT, id1, HIGH, NOW))!.held).toEqual([]);

    const denied = fakeTx({
      configs: [fmRow("ship")],
      addons: [FLEET],
      overrides: [ovrRow({ featureKey: FLEET, effect: "DENY" })],
    });
    const id2 = await seedSnapshot(denied, [fmRow("delivery")]);
    expect((await svc.restoreSnapshot(denied.tx, TENANT, id2, HIGH, NOW))!.held).toMatchObject([
      { reason: "FULFILMENT_MODE_NEEDS_FLEET" },
    ]);
  });

  // M1: the restore runs inside a checkout BEFORE the same transaction activates the add-on rows it buys.
  it("M1: add-on keys the same transaction will activate count as held, so `delivery` restores (future-proofing: no fleet module is self-service today)", async () => {
    const t = fakeTx({ configs: [fmRow("ship")] }); // no TenantAddon row yet: the checkout activates it after the hook
    await seedSnapshot(t, [fmRow("delivery")]);

    const res = await svc.restoreLatest(t.tx, TENANT, HIGH, NOW, undefined, undefined, [FLEET]);

    expect(res!.held).toEqual([]);
    expect(t.state.configs[0].mode).toBe("delivery");
    expect(t.state.snapshots[0].restoredAt).toEqual(NOW);
  });

  it("M1 control: no fleet anywhere (no row, nothing pending) is still held; a non-fleet pending key does not help; a live DENY beats a pending key", async () => {
    const none = fakeTx({ configs: [fmRow("ship")] });
    await seedSnapshot(none, [fmRow("delivery")]);
    expect((await svc.restoreLatest(none.tx, TENANT, HIGH, NOW))!.held).toMatchObject([
      { reason: "FULFILMENT_MODE_NEEDS_FLEET" },
    ]);

    const other = fakeTx({ configs: [fmRow("ship")] });
    await seedSnapshot(other, [fmRow("delivery")]);
    expect(
      (await svc.restoreLatest(other.tx, TENANT, HIGH, NOW, undefined, undefined, ["other_sku"]))!
        .held,
    ).toHaveLength(1);

    const denied = fakeTx({
      configs: [fmRow("ship")],
      overrides: [ovrRow({ featureKey: FLEET, effect: "DENY" })],
    });
    await seedSnapshot(denied, [fmRow("delivery")]);
    expect(
      (await svc.restoreLatest(denied.tx, TENANT, HIGH, NOW, undefined, undefined, [FLEET]))!.held,
    ).toHaveLength(1);
  });

  it("a non-fleet mode never queries the add-ons (ship/pickup/unset need no fleet)", async () => {
    const t = fakeTx({ configs: [fmRow("ship")] });
    const id = await seedSnapshot(t, [fmRow("pickup")]);
    await svc.restoreSnapshot(t.tx, TENANT, id, HIGH, NOW);
    expect(t.tx.tenantAddon.findMany).not.toHaveBeenCalled();
  });

  it("in transit wins over needs-fleet: one row, one reason", async () => {
    const t = fakeTx({ configs: [fmRow("ship")], inTransit: 1 });
    const id = await seedSnapshot(t, [fmRow("delivery")]); // ship -> delivery crosses AND has no fleet
    const res = await svc.restoreSnapshot(t.tx, TENANT, id, HIGH, NOW);
    expect(res!.held).toHaveLength(1);
    expect(res!.held[0].reason).toBe("CARRIER_IN_TRANSIT");
  });

  it("previewRestore lists the held row as skipped with its reason and writes nothing (preview == apply)", async () => {
    const t = fakeTx({ configs: [fmRow("delivery")], inTransit: 2 });
    const id = await seedSnapshot(t, [fmRow("ship"), cfgRow()]);

    const pre = await svc.previewRestore(t.tx, TENANT, id, NOW);

    expect(pre!.plan!.configs.skipped).toEqual([{ featureKey: FM, reason: "CARRIER_IN_TRANSIT" }]);
    expect(pre!.plan!.configs.update.map((u) => u.entry.featureKey)).not.toContain(FM);
    expect(t.state.configs.find((c) => c.featureKey === FM)!.mode).toBe("delivery");
    expect(t.state.snapshots[0].restoredAt).toBeNull();
  });

  describe("a held snapshot stays CLAIMABLE (Q4) and cannot loop or double-apply harmfully", () => {
    it("Restore Now again after the orders are delivered applies the held row, leaves the rest unchanged, THEN stamps and supersedes", async () => {
      const t = fakeTx({
        configs: [fmRow("delivery"), cfgRow({ settings: { stale: 1 } })],
        inTransit: 2,
      });
      const older = await seedSnapshot(t, [cfgRow()], [], new Date("2026-09-05T00:00:00.000Z"));
      const id = await seedSnapshot(t, [fmRow("ship"), cfgRow()]);

      const first = await svc.restoreSnapshot(t.tx, TENANT, id, HIGH, NOW);
      expect(first!.held).toHaveLength(1);

      t.state.inTransit = 0; // delivered
      const second = await svc.restoreSnapshot(t.tx, TENANT, id, HIGH, NOW);

      expect(second!.held).toEqual([]);
      // the already-restored row is NOT re-written: the first run made it match -> unchanged
      expect(second!.report).toEqual({ restored: 1, skipped: 0, keptNewer: 0, unchanged: 1 });
      expect(t.state.configs.find((c) => c.featureKey === FM)!.mode).toBe("ship");
      expect(t.state.snapshots.find((s) => s.id === id)).toMatchObject({
        restoredAt: NOW,
        restoredToPlanKey: HIGH,
      });
      expect(t.state.snapshots.find((s) => s.id === older)!.restoredToPlanKey).toBe("SUPERSEDED");
      // and a third call finds it consumed
      expect(await svc.restoreSnapshot(t.tx, TENANT, id, HIGH, NOW)).toBeNull();
    });

    it("an automatic re-upgrade re-picks the held snapshot each time: the restored rows are unchanged (no growth, no loop), the held row stays held", async () => {
      const t = fakeTx({
        configs: [fmRow("delivery"), cfgRow({ settings: { stale: 1 } })],
        inTransit: 2,
      });
      await seedSnapshot(t, [fmRow("ship"), cfgRow()]);

      const first = await svc.restoreLatest(t.tx, TENANT, HIGH, NOW);
      const afterFirst = JSON.stringify(t.state.configs);
      const second = await svc.restoreLatest(t.tx, TENANT, HIGH, NOW);

      expect(first!.report).toMatchObject({ restored: 1, skipped: 1 });
      expect(second!.report).toEqual({ restored: 0, skipped: 1, keptNewer: 0, unchanged: 1 });
      expect(second!.held).toHaveLength(1);
      expect(JSON.stringify(t.state.configs)).toBe(afterFirst);
      expect(t.state.snapshots[0].restoredAt).toBeNull();
    });

    it("a later change by the tenant wins: if fulfilment_model was edited after the downgrade the row is keptNewer, not held, and the snapshot completes", async () => {
      const t = fakeTx({
        configs: [fmRow("pickup", { updatedAt: new Date("2026-09-15T00:00:00.000Z") })],
        inTransit: 2,
      });
      await seedSnapshot(t, [fmRow("ship")]);
      const res = await svc.restoreLatest(t.tx, TENANT, HIGH, NOW);
      expect(res!.held).toEqual([]);
      expect(res!.report.keptNewer).toBe(1);
      expect(t.state.snapshots[0].restoredAt).toEqual(NOW);
    });

    it("the claim still serialises two runs: a held run takes the row lock via the conditional touch, and loses to an already-stamped snapshot", async () => {
      const t = fakeTx({ configs: [fmRow("delivery")], inTransit: 2 });
      const id = await seedSnapshot(t, [fmRow("ship"), cfgRow()]);
      const claim = jest.spyOn(t.tx.tenantFeatureConfigSnapshot, "updateMany");

      await svc.restoreSnapshot(t.tx, TENANT, id, HIGH, NOW);
      expect(claim).toHaveBeenCalledWith({
        where: { id, tenantId: TENANT, restoredAt: null },
        data: { restoredToPlanKey: null },
      });

      // another run stamped it between our read and our claim: the touch matches 0 rows -> null, no writes
      const writes = JSON.stringify(t.state.configs);
      (t.tx.tenantFeatureConfigSnapshot as any).findFirst = async () => ({
        ...t.state.snapshots[0],
        restoredAt: null,
      });
      t.state.snapshots[0].restoredAt = NOW;
      expect(await svc.restoreSnapshot(t.tx, TENANT, id, HIGH, NOW)).toBeNull();
      expect(JSON.stringify(t.state.configs)).toBe(writes);
    });
  });
});
