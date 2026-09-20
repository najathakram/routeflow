import { FEATURE_REGISTRY } from "./feature-registry";
import {
  buildSnapshotPayload,
  parseSnapshotPayload,
  type ConfigRow,
  type OverrideRow,
} from "./tenant-config-snapshot";

// Keys/modes are read from the live registry at test time — never re-typed here — so a registry
// rename fails the assumption loudly instead of leaving a stale literal green (L-206).
const configFeature = FEATURE_REGISTRY.find((f) => f.config)!;
const CONFIG_KEY = configFeature.key;
const MODES = Object.keys(configFeature.config!.modes);
const MODE_A = MODES[0];
const PLAIN_KEY = FEATURE_REGISTRY.find((f) => !f.config)!.key;
const OTHER_PLAIN_KEY = FEATURE_REGISTRY.filter((f) => !f.config)[1].key;

const BEFORE = new Date("2026-09-01T00:00:00.000Z");
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
