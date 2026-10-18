import { FEATURE_REGISTRY } from "./feature-registry";
import {
  buildSnapshotPayload,
  parseSnapshotPayload,
  planRestore,
  summarizeRestore,
  holdConfigEntry,
  fleetHeldAfterRestore,
  FULFILMENT_MODEL_KEY,
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

describe("holdConfigEntry (BO-13)", () => {
  const payloadFor = (entries: { featureKey: string; mode: string }[]) =>
    buildSnapshotPayload(
      entries.map((e, i) => cfg({ id: `s${i}`, ...e })),
      [],
      T_SNAPSHOT,
    );

  it("moves an UPDATE to skipped with the reason (restored -1, skipped +1)", () => {
    const plan = planRestore(
      payloadFor([{ featureKey: CONFIG_KEY, mode: MODE_B }]),
      { configs: [cfg({ mode: MODE_A })], overrides: [] },
      T_SNAPSHOT,
      NOW,
    );
    expect(plan.configs.update).toHaveLength(1);
    const before = summarizeRestore(plan);

    const held = holdConfigEntry(plan, CONFIG_KEY, "CARRIER_IN_TRANSIT");

    expect(held.configs.update).toEqual([]);
    expect(held.configs.skipped).toEqual([
      { featureKey: CONFIG_KEY, reason: "CARRIER_IN_TRANSIT" },
    ]);
    const after = summarizeRestore(held);
    expect(after.restored).toBe(before.restored - 1);
    expect(after.skipped).toBe(before.skipped + 1);
    // pure: the input plan is untouched
    expect(plan.configs.update).toHaveLength(1);
    expect(plan.configs.skipped).toEqual([]);
  });

  it("moves a CREATE to skipped with the reason", () => {
    const plan = planRestore(
      payloadFor([{ featureKey: CONFIG_KEY, mode: MODE_B }]),
      { configs: [], overrides: [] },
      T_SNAPSHOT,
      NOW,
    );
    expect(plan.configs.create).toHaveLength(1);
    const held = holdConfigEntry(plan, CONFIG_KEY, "FULFILMENT_MODE_NEEDS_FLEET");
    expect(held.configs.create).toEqual([]);
    expect(held.configs.skipped).toEqual([
      { featureKey: CONFIG_KEY, reason: "FULFILMENT_MODE_NEEDS_FLEET" },
    ]);
  });

  it("leaves unchanged, keptNewer and other writes alone", () => {
    const keys = FEATURE_REGISTRY.filter((f) => f.config).map((f) => f.key);
    const [a, b, c] = keys;
    const mode = (k: string) =>
      Object.keys(FEATURE_REGISTRY.find((f) => f.key === k)!.config!.modes);
    const plan = planRestore(
      payloadFor([
        { featureKey: a, mode: mode(a)[0] }, // unchanged
        { featureKey: b, mode: mode(b)[1] ?? mode(b)[0] }, // keptNewer (row updated after the snapshot)
        { featureKey: c, mode: mode(c)[0] }, // create
      ]),
      {
        configs: [
          cfg({ id: "ca", featureKey: a, mode: mode(a)[0] }),
          cfg({ id: "cb", featureKey: b, mode: "other", updatedAt: AFTER }),
        ],
        overrides: [],
      },
      T_SNAPSHOT,
      NOW,
    );
    expect(plan.configs.unchanged).toEqual([a]);
    expect(plan.configs.keptNewer).toEqual([b]);
    expect(holdConfigEntry(plan, a, "CARRIER_IN_TRANSIT")).toBe(plan);
    expect(holdConfigEntry(plan, b, "CARRIER_IN_TRANSIT")).toBe(plan);
    expect(holdConfigEntry(plan, "not_a_key", "CARRIER_IN_TRANSIT")).toBe(plan);
    const held = holdConfigEntry(plan, c, "CARRIER_IN_TRANSIT");
    expect(held.configs.unchanged).toEqual([a]);
    expect(held.configs.keptNewer).toEqual([b]);
    expect(held.configs.create).toEqual([]);
  });

  it("names the delivery-method key the registry actually has", () => {
    expect(FEATURE_REGISTRY.some((f) => f.key === FULFILMENT_MODEL_KEY && f.config)).toBe(true);
  });
});

describe("fleetHeldAfterRestore (BO-13)", () => {
  const fleetKey = "order_delivery";
  const emptyPlan = () =>
    planRestore(
      { version: 1, configs: [], overrides: [] },
      { configs: [], overrides: [] },
      T_SNAPSHOT,
      NOW,
    );
  const grantEntry = {
    featureKey: fleetKey,
    effect: "GRANT" as const,
    kind: "COMP",
    reason: "x",
    expiresAt: null,
    createdById: null,
  };

  it("is true when an active add-on row holds a fleet key, false with none", () => {
    expect(
      fleetHeldAfterRestore(emptyPlan(), { overrides: [], activeAddonKeys: [fleetKey] }, NOW),
    ).toBe(true);
    expect(
      fleetHeldAfterRestore(emptyPlan(), { overrides: [], activeAddonKeys: ["other"] }, NOW),
    ).toBe(false);
  });

  it("counts the restore's OWN override create: a restored GRANT holds the fleet", () => {
    const plan = planRestore(
      { version: 1, configs: [], overrides: [grantEntry] },
      { configs: [], overrides: [] },
      T_SNAPSHOT,
      NOW,
    );
    expect(plan.overrides.create).toHaveLength(1);
    expect(fleetHeldAfterRestore(plan, { overrides: [], activeAddonKeys: [] }, NOW)).toBe(true);
  });

  it("an active DENY removes an add-on row; a revoked or expired one does not", () => {
    expect(
      fleetHeldAfterRestore(
        emptyPlan(),
        { overrides: [ovr({ featureKey: fleetKey, effect: "DENY" })], activeAddonKeys: [fleetKey] },
        NOW,
      ),
    ).toBe(false);
    expect(
      fleetHeldAfterRestore(
        emptyPlan(),
        {
          overrides: [ovr({ featureKey: fleetKey, effect: "DENY", revokedAt: BEFORE })],
          activeAddonKeys: [fleetKey],
        },
        NOW,
      ),
    ).toBe(true);
  });
});
