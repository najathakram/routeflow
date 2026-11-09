import * as fs from "fs";
import * as path from "path";
import { BusinessProfileService } from "./business-profile.service";
import { BUSINESS_PROFILES, PROFILE_MODULE_KEYS } from "./business-profiles";
import { FeatureOverrideService } from "./feature-override.service";
import { OVERRIDE_RULE_ORDER } from "./feature-override-rule";
import { currentEffects, fleetHeldAfterRestore } from "./tenant-config-snapshot";

/**
 * B1282 (class reach, review B at 91751617a8): "which override row applies to a key" is ONE rule
 * (`feature-override-rule.ts`) and the read order is ONE order, `OVERRIDE_RULE_ORDER` (newest first: createdAt desc, then id
 * desc, so a higher id is the newer row on a createdAt tie). Every read that feeds the rule carries it. Every reader of
 * stored override rows goes through it, so the business-profile screen, the served answer (`allActive`) and the
 * pilot-ending job cannot disagree on a same-key tie, and no file keeps its own copy of "is this row live".
 */
const T = "tenant-a";
const DAY = 86_400_000;
const NOW = Date.now();

const row = (
  id: string,
  featureKey: string,
  effect: "GRANT" | "DENY",
  expiresAt: Date | null = null,
) => ({
  id,
  tenantId: T,
  featureKey,
  effect,
  kind: "MANUAL",
  reason: null,
  revokedAt: null,
  expiresAt,
});

// Newest first, as the reads return them (`createdAt desc`): the tie's FIRST row is the newest.
const MODULE = PROFILE_MODULE_KEYS[0];
const ROWS = [
  row("ov-new", MODULE, "GRANT"), // the newest of a same-key tie
  row("ov-old", MODULE, "DENY"),
  row("ov-expired", "driver_payments", "GRANT", new Date(NOW - DAY)), // expired: never applies
  row("ov-live", "driver_payments", "DENY", new Date(NOW + DAY)),
];

function build() {
  const prisma = { tenantFeatureOverride: { findMany: jest.fn().mockResolvedValue(ROWS) } };
  const featureOverrides = new FeatureOverrideService(prisma as any);
  const profilePrisma = { tenantAddon: { findFirst: jest.fn().mockResolvedValue(null) } };
  const svc = new BusinessProfileService(
    profilePrisma as any,
    featureOverrides,
    { getActiveAddons: jest.fn().mockResolvedValue([]) } as any,
    { getState: jest.fn().mockResolvedValue({ value: "off" }) } as any,
    {} as any,
  );
  return { svc, featureOverrides, prisma };
}

describe("B1282 class: the business-profile readers use the one override rule", () => {
  it("currentState reads a tied module key the way allActive does (the newest live row), and acts on that row's id", async () => {
    const { svc, featureOverrides } = build();
    const served = await featureOverrides.allActive(T);
    const { state, activeIds } = await (svc as any).currentState(T, BUSINESS_PROFILES[0]);
    expect(served.get(MODULE)).toBe("GRANT");
    expect(state.overrides.get(MODULE)).toBe(served.get(MODULE));
    expect(activeIds.get(MODULE)).toBe("ov-new");
    // an expired row never supplies an effect or an id
    expect(state.overrides.get("driver_payments")).toBe(served.get("driver_payments"));
    expect(activeIds.get("driver_payments")).toBe("ov-live");
  });

  it("heldDoorPayments reads driver_payments from the same live row as allActive", async () => {
    const { svc, featureOverrides } = build();
    const served = await featureOverrides.allActive(T);
    expect(served.get("driver_payments")).toBe("DENY");
    expect(await (svc as any).heldDoorPayments(T)).toBe(false);
  });

  it("the reads that feed 'first' have one defined order: createdAt desc, then id desc", async () => {
    const { featureOverrides, prisma } = build();
    await featureOverrides.allActive(T);
    await featureOverrides.list(T);
    for (const call of prisma.tenantFeatureOverride.findMany.mock.calls) {
      expect(call[0].orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    }
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenCalledTimes(2);
    const job = fs.readFileSync(path.join(__dirname, "feature-override-review.job.ts"), "utf8");
    expect(job).toMatch(/id: \{ not: row\.id \}[\s\S]{0,120}orderBy: OVERRIDE_RULE_ORDER/);
  });

  it("N-3: the business-profile reads resolve a same-key tie the same whatever physical order the database holds", async () => {
    const T0 = new Date(NOW - DAY); // identical createdAt: the id decides; the higher id is the newer row
    const tie = (id: string, effect: "GRANT" | "DENY") => ({
      ...row(id, MODULE, effect),
      createdAt: T0,
    });
    const physical = [
      [tie("ov-1", "GRANT"), tie("ov-2", "DENY")],
      [tie("ov-2", "DENY"), tie("ov-1", "GRANT")],
    ];
    for (const rows of physical) {
      const prisma = {
        tenantFeatureOverride: {
          findMany: jest.fn(({ orderBy }: any) => Promise.resolve(sortByOrder(rows, orderBy))),
        },
      };
      const featureOverrides = new FeatureOverrideService(prisma as any);
      const svc = new BusinessProfileService(
        { tenantAddon: { findFirst: jest.fn().mockResolvedValue(null) } } as any,
        featureOverrides,
        { getActiveAddons: jest.fn().mockResolvedValue([]) } as any,
        { getState: jest.fn().mockResolvedValue({ value: "off" }) } as any,
        {} as any,
      );
      const served = await featureOverrides.allActive(T);
      const { state, activeIds } = await (svc as any).currentState(T, BUSINESS_PROFILES[0]);
      expect(served.get(MODULE)).toBe("DENY");
      expect(state.overrides.get(MODULE)).toBe("DENY");
      expect(activeIds.get(MODULE)).toBe("ov-2");
    }
  });

  it("the snapshot restore guard reads a same-key tie the way allActive does (newest GRANT beats the older DENY), whatever the physical order", async () => {
    const FLEET = "order_delivery";
    const T1 = new Date(NOW - 2 * DAY);
    const T2 = new Date(NOW - DAY);
    const snap = (id: string, effect: "GRANT" | "DENY", createdAt: Date) => ({
      ...row(id, FLEET, effect),
      createdAt,
      createdById: null,
    });
    const plan = {
      configs: { create: [], update: [], unchanged: [], keptNewer: [], skipped: [] },
      overrides: { create: [], unchanged: [], keptNewer: [], skipped: [] },
    };
    for (const physical of [
      [snap("ov-new", "GRANT", T2), snap("ov-old", "DENY", T1)],
      [snap("ov-old", "DENY", T1), snap("ov-new", "GRANT", T2)],
    ]) {
      const prisma = {
        tenantFeatureOverride: {
          findMany: jest.fn(({ orderBy }: any) => Promise.resolve(sortByOrder(physical, orderBy))),
        },
      };
      const served = await new FeatureOverrideService(prisma as any).allActive(T);
      expect(served.get(FLEET)).toBe("GRANT");
      // what the snapshot service reads (it passes OVERRIDE_RULE_ORDER; pinned by the read-order table below)
      const read = sortByOrder(physical, OVERRIDE_RULE_ORDER) as any[];
      expect(currentEffects(read, new Date(NOW))).toEqual([[FLEET, "GRANT"]]);
      expect(
        fleetHeldAfterRestore(plan, { overrides: read, activeAddonKeys: [] }, new Date(NOW)),
      ).toBe(true);
    }
  });

  it("planRestore picks the stored row that applies through the one rule (pickLiveRow), never its own `.find(isActive)`", () => {
    const text = fs.readFileSync(path.join(__dirname, "tenant-config-snapshot.ts"), "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).toMatch(/pickLiveRow\(/);
    expect(code).not.toMatch(/\.(find|findLast)\(\s*\(?\w+\)?\s*=>\s*isActive\(/);
    expect("rows.find((o) => isActive(o, now))").toMatch(
      /\.(find|findLast)\(\s*\(?\w+\)?\s*=>\s*isActive\(/,
    );
  });
});

/** What the database does with an `orderBy`; a read with none keeps the physical order it was handed. */
function sortByOrder(rows: any[], orderBy?: ReadonlyArray<Record<string, unknown>>): any[] {
  if (!orderBy) return rows;
  const val = (v: unknown) => (v instanceof Date ? v.getTime() : v);
  return [...rows].sort((a, b) => {
    for (const o of orderBy) {
      const [key, dir] = Object.entries(o)[0];
      const av = val(a[key]);
      const bv = val(b[key]);
      if (av === bv || av === undefined || bv === undefined) continue;
      const c = (av as number) < (bv as number) ? -1 : 1;
      return dir === "desc" ? -c : c;
    }
    return 0;
  });
}

/**
 * Every `tenantFeatureOverride.findMany` that feeds the rule carries `OVERRIDE_RULE_ORDER`. The table is the reads that
 * feed it; every other read in billing/ is a different question (the pilot candidates page, the sweep's hash input, the
 * snapshot's whole-set read, the expiry chunk) and says which.
 */
const FEEDING_READS: Record<string, number> = {
  "billing/feature-override.service.ts": 2, // activeRows (the served answer) and list() (business-profile)
  "billing/addon-invariant.job.ts": 1, // invariant I5: the keys the applying row DENIES
  "billing/feature-override-review.job.ts": 1, // the other-overrides read
  "billing/tenant-config-snapshot.service.ts": 3, // take, preview and apply read the set that feeds isActive / currentEffects
};
const OTHER_READS: Record<string, number> = {
  "billing/entitlement-sweep.service.ts": 1, // hash input only
  "billing/feature-override-review.job.ts": 2, // expired page, ending-soon page
  "billing/feature-override.service.ts": 1, // the expiry chunk
  "platform-admin/feature-change.service.ts": 2, // WP11: the save's hash input, and the live rows of one key it is about to revoke (no served answer)
};

describe("N-3: each read that feeds the one rule carries OVERRIDE_RULE_ORDER", () => {
  const SRC_ROOT = path.join(__dirname, "..");
  const scanFiles = () =>
    walk(path.join(SRC_ROOT, "billing")).concat(walk(path.join(SRC_ROOT, "platform-admin")));
  const scanReads = () => {
    const reads = new Map<string, { ordered: number; total: number }>();
    for (const f of scanFiles()) {
      const text = strip(fs.readFileSync(f, "utf8"));
      const total = (text.match(/tenantFeatureOverride\.findMany\(/g) ?? []).length;
      if (!total) continue;
      const ordered = (text.match(/orderBy:\s*OVERRIDE_RULE_ORDER/g) ?? []).length;
      reads.set(path.relative(SRC_ROOT, f).split(path.sep).join("/"), { ordered, total });
    }
    return reads;
  };

  it("the feeding reads are ordered by the constant, and nothing else orders an override read differently", () => {
    const reads = scanReads();
    for (const [file, n] of Object.entries(FEEDING_READS)) {
      expect(reads.get(file)?.ordered).toBe(n);
    }
    for (const [file, v] of reads) {
      expect(v.ordered).toBe(FEEDING_READS[file] ?? 0);
      expect(v.total).toBe((FEEDING_READS[file] ?? 0) + (OTHER_READS[file] ?? 0));
    }
  });

  it("the rule's constant is the one order, newest first, and no reader spells the order out", () => {
    const rule = fs.readFileSync(path.join(__dirname, "feature-override-rule.ts"), "utf8");
    expect(rule).toMatch(/export const OVERRIDE_RULE_ORDER = \[\{ createdAt: "desc"/);
    for (const f of scanFiles()) {
      if (f.endsWith("feature-override-rule.ts")) continue;
      expect(strip(fs.readFileSync(f, "utf8"))).not.toMatch(/createdAt: "desc"\s*\}?,?\s*\{ id:/);
    }
  });
});

/**
 * The structural pin (class, not instance). Outside `feature-override-rule.ts`, no non-spec .ts under billing/ or
 * platform-admin/ may decide "is this override row live" inline, or build an effect map over stored rows with `.set(`.
 * Each allowed hit is a different question (named), and the list may only shrink.
 */
const SRC = path.join(__dirname, "..");
const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(dir, e.name))
        : e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")
          ? [path.join(dir, e.name)]
          : [],
    );
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const LIVE_CHECK =
  /expiresAt\??\.getTime\(\)\s*(<=|>=|<|>)|expiresAt\s*(&&|===?\s*null|!==?\s*null)|\b(?:o|r|row|ov|override)\.expiresAt\s*[<>]=?\s*now\b/g;
const EFFECT_MAP = /[oO]verrides\.set\(|new Map(?:<[^>]*>)?\([^)]*[eE]ffects/g;

/** file (relative to src) -> [expected live-check hits, expected effect-map hits], with the reason it is a different question. */
const ALLOWED: Record<string, { live: number; set: number; why: string }> = {
  "billing/feature-override-rule.ts": { live: 2, set: 0, why: "the rule itself" },
  "billing/billable-pilot-ending.ts": {
    live: 3,
    set: 0,
    why: "the pilot row's OWN window (is it inside the warning horizon), not which row applies to a key",
  },
  "billing/entitlement-sweep.service.ts": {
    live: 2,
    set: 0,
    why: "hash-only `live:` flag over raw rows; the effect itself is read through allActive",
  },
  "billing/feature-override.service.ts": {
    live: 2,
    set: 0,
    why: "create-time validation of a NEW row's own expiry (not in the past)",
  },
  "billing/override-restore-verdict.ts": {
    live: 0,
    set: 1,
    why: "decides over `ctx.effects`, which the caller already resolved through the rule (current part first, the plan's creates last)",
  },
  "billing/tenant-config-snapshot.ts": {
    live: 1,
    set: 0,
    why: "a SAVED snapshot entry's own expiry while the restore plans (is the stored entry already past), not which stored row applies",
  },
  "platform-admin/feature-change.service.ts": {
    live: 3,
    set: 0,
    why: "WP11: the save's hash `live:` flag (hash-only, like the sweep), a NEW change's own end date (not in the past), and the no-op check against the live row it is about to replace",
  },
  "billing/feature-preview.service.ts": {
    live: 0,
    set: 1,
    why: "`afterOverrides` is the request's PROPOSED overrides, not a reading of stored rows",
  },
};

describe("B1282 class: no override reader keeps its own live check or effect map", () => {
  const files = [...walk(path.join(SRC, "billing")), ...walk(path.join(SRC, "platform-admin"))];
  const hits = new Map<string, { live: number; set: number }>();
  for (const f of files) {
    const text = strip(fs.readFileSync(f, "utf8"));
    const live = (text.match(LIVE_CHECK) ?? []).length;
    const set = (text.match(EFFECT_MAP) ?? []).length;
    if (live || set) hits.set(path.relative(SRC, f).split(path.sep).join("/"), { live, set });
  }

  it("every file with an inline live check or an effect-map write is allow-listed, with its exact count", () => {
    const actual = Object.fromEntries(hits);
    const expected = Object.fromEntries(
      Object.entries(ALLOWED).map(([k, v]) => [k, { live: v.live, set: v.set }]),
    );
    expect(actual).toEqual(expected);
  });

  it("the scan sees the planted shapes (non-vacuous)", () => {
    expect(
      "if (r.expiresAt && r.expiresAt.getTime() <= now) continue;".match(LIVE_CHECK)?.length,
    ).toBe(2);
    expect("overrides.set(r.featureKey, r.effect);".match(EFFECT_MAP)?.length).toBe(1);
    // the shapes review B named: an inline null-or-future check, a bare `> now`, and a Map built over override effects
    expect(
      "o.revokedAt === null && (o.expiresAt === null || o.expiresAt > now)".match(LIVE_CHECK)
        ?.length,
    ).toBe(2);
    expect("row.expiresAt < now".match(LIVE_CHECK)?.length).toBe(1);
    expect("this.cached.expiresAt > now".match(LIVE_CHECK)).toBeNull(); // a cache TTL is a different question
    expect('new Map<string, "GRANT" | "DENY">(ctx.effects)'.match(EFFECT_MAP)?.length).toBe(1);
  });
});
