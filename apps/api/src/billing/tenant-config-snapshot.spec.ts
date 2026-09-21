import { FEATURE_REGISTRY } from "./feature-registry";
import {
  buildSnapshotPayload,
  parseSnapshotPayload,
  planRestore,
  summarizeRestore,
  type ConfigRow,
  type OverrideRow,
} from "./tenant-config-snapshot";

// Keys/modes are read from the live registry at test time — never re-typed here — so a registry
// rename fails the assumption loudly instead of leaving a stale literal green (L-206).
const configFeature = FEATURE_REGISTRY.find((f) => f.config)!;
const CONFIG_KEY = configFeature.key;
const MODES = Object.keys(configFeature.config!.modes);
const MODE_A = MODES[0];
const MODE_B = MODES.find((m) => m !== MODE_A)!;
const PLAIN_KEY = FEATURE_REGISTRY.find((f) => !f.config)!.key;
const PLAN_KEY_UNDER_TEST = PLAIN_KEY;
const OTHER_PLAIN_KEY = FEATURE_REGISTRY.filter((f) => !f.config)[1].key;

const T_SNAPSHOT = new Date("2026-09-10T12:00:00.000Z");
const BEFORE = new Date("2026-09-01T00:00:00.000Z");
const AFTER = new Date("2026-09-15T00:00:00.000Z");
const NOW = new Date("2026-09-20T00:00:00.000Z");

const cfg = (over: Partial<ConfigRow> = {}): ConfigRow => ({
  id: "c1",
  featureKey: CONFIG_KEY,
  mode: MODE_A,
  settings: { a: 1, b: [1, 2] },
  reason: "pilot",
  updatedById: "u1",
  updatedAt: BEFORE,
  ...over,
});

const ovr = (over: Partial<OverrideRow> = {}): OverrideRow => ({
  id: "o1",
  featureKey: PLAIN_KEY,
  effect: "GRANT",
  kind: "COMP",
  reason: "support",
  expiresAt: null,
  createdById: "u1",
  createdAt: BEFORE,
  revokedAt: null,
  ...over,
});

describe("buildSnapshotPayload", () => {
  it("captures every config row and only ACTIVE overrides, in a deterministic order", () => {
    const payload = buildSnapshotPayload(
      [cfg({ id: "c2", featureKey: "zzz" }), cfg()],
      [
        ovr({ id: "o1", featureKey: OTHER_PLAIN_KEY }),
        ovr({ id: "o2", featureKey: PLAIN_KEY, revokedAt: BEFORE }),
        ovr({ id: "o3", featureKey: PLAIN_KEY, expiresAt: new Date("2026-09-19T00:00:00.000Z") }),
        ovr({ id: "o4", featureKey: PLAIN_KEY, expiresAt: new Date("2026-12-01T00:00:00.000Z") }),
      ],
      NOW,
    );
    expect(payload.version).toBe(1);
    expect(payload.configs.map((c) => c.featureKey)).toEqual([CONFIG_KEY, "zzz"].sort());
    // revoked (o2) and already-expired (o3) are excluded; o1 + o4 stay
    expect(payload.overrides).toHaveLength(2);
    expect(payload.overrides.map((o) => o.featureKey)).toEqual([OTHER_PLAIN_KEY, PLAIN_KEY].sort());
  });

  it("is deterministic — the same state serialises byte-identically", () => {
    const a = buildSnapshotPayload([cfg()], [ovr()], NOW);
    const b = buildSnapshotPayload([cfg()], [ovr()], NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("stores null for absent settings and an ISO string for expiresAt", () => {
    const payload = buildSnapshotPayload(
      [cfg({ settings: undefined })],
      [ovr({ expiresAt: new Date("2026-12-01T00:00:00.000Z") })],
      NOW,
    );
    expect(payload.configs[0].settings).toBeNull();
    expect(payload.overrides[0].expiresAt).toBe("2026-12-01T00:00:00.000Z");
  });
});

describe("planRestore — configs", () => {
  const payload = buildSnapshotPayload([cfg()], [], NOW);

  it("recreates an entry that the downgrade left absent (as-was)", () => {
    const plan = planRestore(payload, { configs: [], overrides: [] }, T_SNAPSHOT, NOW);
    expect(plan.configs.create).toHaveLength(1);
    expect(plan.configs.create[0]).toMatchObject({ featureKey: CONFIG_KEY, mode: MODE_A });
  });

  it("updates a row the tenant did NOT touch since the snapshot back to the snapshot value", () => {
    const current = cfg({ mode: MODE_B, settings: { changed: true }, updatedAt: BEFORE });
    const plan = planRestore(payload, { configs: [current], overrides: [] }, T_SNAPSHOT, NOW);
    expect(plan.configs.update).toHaveLength(1);
    expect(plan.configs.update[0].id).toBe("c1");
    expect(plan.configs.update[0].entry.mode).toBe(MODE_A);
  });

  it("never overwrites a value changed AFTER the downgrade — newer wins and is reported", () => {
    const current = cfg({ mode: MODE_B, updatedAt: AFTER });
    const plan = planRestore(payload, { configs: [current], overrides: [] }, T_SNAPSHOT, NOW);
    expect(plan.configs.keptNewer).toEqual([CONFIG_KEY]);
    expect(plan.configs.update).toHaveLength(0);
    expect(plan.configs.create).toHaveLength(0);
  });

  it("is idempotent — an identical row (settings key order irrelevant) is a no-op", () => {
    const current = cfg({ settings: { b: [1, 2], a: 1 }, updatedAt: AFTER });
    const plan = planRestore(payload, { configs: [current], overrides: [] }, T_SNAPSHOT, NOW);
    expect(plan.configs.unchanged).toEqual([CONFIG_KEY]);
    expect(summarizeRestore(plan)).toEqual({
      restored: 0,
      skipped: 0,
      keptNewer: 0,
      unchanged: 1,
    });
  });

  it("skips and reports an entry whose feature the platform no longer has", () => {
    const stale = buildSnapshotPayload([cfg({ featureKey: "removed_feature_xyz" })], [], NOW);
    const plan = planRestore(stale, { configs: [], overrides: [] }, T_SNAPSHOT, NOW);
    expect(plan.configs.skipped).toEqual([
      { featureKey: "removed_feature_xyz", reason: "UNKNOWN_FEATURE" },
    ]);
    expect(plan.configs.create).toHaveLength(0);
  });

  it("skips a mode the feature no longer offers, and a non-config feature carrying a mode", () => {
    const gone = buildSnapshotPayload([cfg({ mode: "retired_mode" })], [], NOW);
    expect(
      planRestore(gone, { configs: [], overrides: [] }, T_SNAPSHOT, NOW).configs.skipped,
    ).toEqual([{ featureKey: CONFIG_KEY, reason: "MODE_NOT_OFFERED" }]);

    const plain = buildSnapshotPayload([cfg({ featureKey: PLAIN_KEY })], [], NOW);
    expect(
      planRestore(plain, { configs: [], overrides: [] }, T_SNAPSHOT, NOW).configs.skipped,
    ).toEqual([{ featureKey: PLAIN_KEY, reason: "MODE_NOT_OFFERED" }]);
  });
});

describe("planRestore — overrides", () => {
  const payload = buildSnapshotPayload([], [ovr()], NOW);

  it("recreates an active override the downgrade left absent", () => {
    const plan = planRestore(payload, { configs: [], overrides: [] }, T_SNAPSHOT, NOW);
    expect(plan.overrides.create).toHaveLength(1);
    expect(plan.overrides.create[0]).toMatchObject({ featureKey: PLAIN_KEY, effect: "GRANT" });
  });

  it("is idempotent — a live override with the same effect is a no-op", () => {
    const plan = planRestore(
      payload,
      { configs: [], overrides: [ovr({ createdAt: AFTER })] },
      T_SNAPSHOT,
      NOW,
    );
    expect(plan.overrides.unchanged).toEqual([PLAIN_KEY]);
    expect(plan.overrides.create).toHaveLength(0);
  });

  it("never replaces a live override that has a different effect", () => {
    const plan = planRestore(
      payload,
      { configs: [], overrides: [ovr({ effect: "DENY", createdAt: AFTER })] },
      T_SNAPSHOT,
      NOW,
    );
    expect(plan.overrides.keptNewer).toEqual([PLAIN_KEY]);
    expect(plan.overrides.create).toHaveLength(0);
  });

  it("a row REVOKED after the downgrade is never resurrected — the admin's revoke wins", () => {
    const plan = planRestore(
      payload,
      { configs: [], overrides: [ovr({ revokedAt: AFTER })] },
      T_SNAPSHOT,
      NOW,
    );
    expect(plan.overrides.keptNewer).toEqual([PLAN_KEY_UNDER_TEST]);
    expect(plan.overrides.create).toHaveLength(0);
  });

  it("a row revoked BEFORE the snapshot is history, not a block — the entry is recreated", () => {
    const plan = planRestore(
      payload,
      { configs: [], overrides: [ovr({ revokedAt: BEFORE })] },
      T_SNAPSHOT,
      NOW,
    );
    expect(plan.overrides.create).toHaveLength(1);
  });

  it("an expired-but-UNREVOKED row occupies the unique slot (revokedAt IS NULL): keep, never create (no P2002)", () => {
    const plan = planRestore(
      payload,
      {
        configs: [],
        overrides: [
          ovr({
            createdAt: BEFORE,
            expiresAt: new Date("2026-09-12T00:00:00.000Z"),
            revokedAt: null,
          }),
        ],
      },
      T_SNAPSHOT,
      NOW,
    );
    expect(plan.overrides.create).toHaveLength(0);
    expect(plan.overrides.keptNewer).toEqual([PLAN_KEY_UNDER_TEST]);
  });

  it("a replacement override created AFTER the downgrade wins over the snapshot's", () => {
    const plan = planRestore(
      payload,
      { configs: [], overrides: [ovr({ effect: "GRANT", createdAt: AFTER, id: "o9" })] },
      T_SNAPSHOT,
      NOW,
    );
    expect(plan.overrides.create).toHaveLength(0);
  });

  it("skips an override that expired between the snapshot and the restore", () => {
    const expiring = buildSnapshotPayload(
      [],
      [ovr({ expiresAt: new Date("2026-09-30T00:00:00.000Z") })],
      T_SNAPSHOT,
    );
    const plan = planRestore(
      expiring,
      { configs: [], overrides: [] },
      T_SNAPSHOT,
      new Date("2026-10-15T00:00:00.000Z"),
    );
    expect(plan.overrides.skipped).toEqual([{ featureKey: PLAIN_KEY, reason: "EXPIRED" }]);
    expect(plan.overrides.create).toHaveLength(0);
  });

  it("summarises restored / skipped / keptNewer / unchanged across configs and overrides", () => {
    const mixed = buildSnapshotPayload(
      [cfg(), cfg({ id: "c9", featureKey: "removed_feature_xyz" })],
      [ovr()],
      NOW,
    );
    const plan = planRestore(mixed, { configs: [], overrides: [] }, T_SNAPSHOT, NOW);
    expect(summarizeRestore(plan)).toEqual({
      restored: 2,
      skipped: 1,
      keptNewer: 0,
      unchanged: 0,
    });
  });
});

describe("planRestore — plan allow-list", () => {
  it("skips and reports an entry the NEW plan does not allow, for configs and overrides alike", () => {
    const payload = buildSnapshotPayload([cfg()], [ovr()], NOW);
    const plan = planRestore(
      payload,
      { configs: [], overrides: [] },
      T_SNAPSHOT,
      NOW,
      (key) => key !== CONFIG_KEY && key !== PLAIN_KEY,
    );
    expect(plan.configs.skipped).toEqual([{ featureKey: CONFIG_KEY, reason: "PLAN_NOT_ALLOWED" }]);
    expect(plan.overrides.skipped).toEqual([{ featureKey: PLAIN_KEY, reason: "PLAN_NOT_ALLOWED" }]);
    expect(summarizeRestore(plan).restored).toBe(0);
  });
});

describe("parseSnapshotPayload", () => {
  it("accepts a version-1 document and rejects everything else (never throws)", () => {
    const ok = buildSnapshotPayload([cfg()], [ovr()], NOW);
    expect(parseSnapshotPayload(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
    expect(parseSnapshotPayload(null)).toBeNull();
    expect(parseSnapshotPayload("x")).toBeNull();
    expect(parseSnapshotPayload({ version: 2, configs: [], overrides: [] })).toBeNull();
    expect(parseSnapshotPayload({ version: 1, configs: {}, overrides: [] })).toBeNull();
    expect(parseSnapshotPayload({ version: 1, configs: [] })).toBeNull();
  });
});
