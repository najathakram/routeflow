import { Prisma } from "@prisma/client";
import { FEATURE_REGISTRY } from "./feature-registry";
import { PLAN_KEYS } from "./plan-catalog.constants";
import { TenantConfigSnapshotService } from "./tenant-config-snapshot.service";

// Plan keys and feature keys come from the live catalog/registry (L-206), never re-typed here.
const HIGH = PLAN_KEYS[PLAN_KEYS.length - 1];
const configFeature = FEATURE_REGISTRY.find((f) => f.config)!;
const CONFIG_KEY = configFeature.key;
const MODE = Object.keys(configFeature.config!.modes)[0];
const PLAIN_KEY = FEATURE_REGISTRY.find((f) => !f.config)!.key;

const TENANT = "t-1";
const T0 = new Date("2026-09-10T12:00:00.000Z");
const NOW = new Date("2026-09-20T00:00:00.000Z");

/** Minimal in-memory tx: just the four delegates the service touches. */
function fakeTx(seed: { configs?: any[]; overrides?: any[]; snapshots?: any[] } = {}) {
  const state = {
    configs: [...(seed.configs ?? [])],
    overrides: [...(seed.overrides ?? [])],
    snapshots: [...(seed.snapshots ?? [])],
    seq: 0,
  };
  const id = (p: string) => `${p}${++state.seq}`;
  const tx = {
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
      create: async ({ data }: any) => {
        const row = { id: id("o"), createdAt: NOW, revokedAt: null, ...data };
        state.overrides.push(row);
        return row;
      },
    },
    tenantFeatureConfigSnapshot: {
      findMany: async ({ where }: any) =>
        state.snapshots
          .filter((s) => s.tenantId === where.tenantId && s.restoredAt === null)
          .sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime()),
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
        const rows = state.snapshots.filter(
          (s) =>
            s.tenantId === where.tenantId &&
            s.restoredAt === null &&
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
