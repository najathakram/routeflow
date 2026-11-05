import * as fs from "fs";
import * as path from "path";
import { BusinessProfileService } from "./business-profile.service";
import { BUSINESS_PROFILES, PROFILE_MODULE_KEYS } from "./business-profiles";
import { FeatureOverrideService } from "./feature-override.service";

/**
 * B1282 (class reach, review B at 91751617a8): "which override row applies to a key" is ONE rule
 * (`feature-override-rule.ts`) and the read order is ONE order (newest first: createdAt desc, id asc). Every reader of
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

  it("the two reads that feed 'first' have one defined order: createdAt desc, then id asc", async () => {
    const { featureOverrides, prisma } = build();
    await featureOverrides.allActive(T);
    expect(prisma.tenantFeatureOverride.findMany.mock.calls[0][0].orderBy).toEqual([
      { createdAt: "desc" },
      { id: "asc" },
    ]);
    const job = fs.readFileSync(path.join(__dirname, "feature-override-review.job.ts"), "utf8");
    expect(job).toMatch(/id: \{ not: row\.id \}[\s\S]{0,120}orderBy: OVERRIDE_READ_ORDER/);
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
const LIVE_CHECK = /expiresAt\??\.getTime\(\)\s*(<=|>=|<|>)|expiresAt\s*(&&|==\s*null|!=\s*null)/g;
const EFFECT_MAP = /[oO]verrides\.set\(/g;

/** file (relative to src) -> [expected live-check hits, expected effect-map hits], with the reason it is a different question. */
const ALLOWED: Record<string, { live: number; set: number; why: string }> = {
  "billing/feature-override-rule.ts": { live: 2, set: 0, why: "the rule itself" },
  "billing/billable-pilot-ending.ts": {
    live: 2,
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
  });
});
