import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LEGACY_PLAN_KEY_ALIASES,
  PLAN_KEYS,
  normalizePlanKey,
  planKeyFromEnum,
} from "./plan-catalog.constants";

/**
 * SA-1254 V1 (P-41, T13): the plan-key vocabulary keeps the SAME ORDER in every place that types
 * it, not only the same set. The order is the rank, and the rank decides whether a plan change
 * takes effect now or at period end, so a reordered copy would bill a move the wrong way.
 *
 * The five places:
 *   1. apps/api/src/billing/plan-catalog.constants.ts (the source);
 *   2. packages/types/api/enums.ts (web and mobile);
 *   3. apps/api/scripts/lib/feature-registry-mirror.cjs, the ONE JS home (SA-1204 C2b);
 *   4. apps/api/scripts/audit-tenant-entitlements.mjs, which carried a drifted hand copy (no LITE,
 *      and SCALE/GROWTH/LITE read as STARTER: SA-1204 A1 F7) and now requires 3;
 *   5. apps/api/scripts/report-noop-addons.mjs (`normalizePlan`) and the alias map of
 *      backfill-subscription-reconciliation.mjs, which now read 3 too.
 *
 * The .mjs files are evaluated in a `node --input-type=module` child (ts-jest cannot import .mjs),
 * the same shim as backfill-subscription-reconciliation-plan-key-parity.spec.ts. No database is
 * touched: both scripts guard their main.
 *
 * Red on master: 2 and 3 have 5 keys, not 7; 3's planKeyFromEnum("CORE") is "STARTER"; and the
 * inventory finds four files that hand-type the TEAM alias.
 */

const API_DIR = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(API_DIR, "..", "..");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mirror = require("../../scripts/lib/feature-registry-mirror.cjs") as {
  PLAN_KEYS: string[];
  LEGACY_PLAN_KEY_ALIASES: Record<string, string>;
  normalizePlanKey: (k: string | null | undefined) => string | null;
  planKeyFromEnum: (k: string | null | undefined) => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shared = require("@routeflow/types") as {
  PLAN_KEYS: readonly string[];
  TENANT_PLAN_VALUES: readonly string[];
};

// Every stored enum value, every key, every alias, plus the edges a hand copy gets wrong.
const PROBES: Array<string | null> = [
  ...new Set([
    ...shared.TENANT_PLAN_VALUES,
    ...PLAN_KEYS,
    ...Object.keys(LEGACY_PLAN_KEY_ALIASES),
    "PLUS",
    "UNKNOWN_TIER",
    "constructor",
    "",
  ]),
  null,
];

const label = (v: string | null) => (v === null ? "null" : JSON.stringify(v));

/**
 * T27 / C2b inventory patterns: each one is a sign that a file hand-types the plan-key helpers.
 * Only lib/feature-registry-mirror.cjs may match them.
 */
const INVENTORY_PATTERNS: Array<[string, RegExp]> = [
  ['case "TEAM"', /case\s+["']TEAM["']/],
  // the TEAM alias, with the key bare or quoted (R-56 F1)
  ['TEAM: "GROWTH"', /\bTEAM["']?\s*:\s*["']GROWTH["']/],
  ["function planKeyFromEnum", /function\s+planKeyFromEnum\b/],
  ["const PLAN_KEYS =", /\bconst\s+PLAN_KEYS\s*=/],
  // the ladder order under any name: a list where STARTER is followed by CORE or GROWTH (R-56 F1)
  ["a plan-key order array", /["']STARTER["']\s*,[^\]]*?["'](?:CORE|GROWTH)["']/],
];
// .ts too: the script trees hold a few TypeScript files (R-56 F1)
const INVENTORY_FILE = /\.(c|m)?[jt]s$/;

function inventoryHits(src: string): string[] {
  return INVENTORY_PATTERNS.filter(([, re]) => re.test(src)).map(([name]) => name);
}

function runModule(source: string): Record<string, unknown> {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: API_DIR,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stderr}`);
  const line = r.stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

describe("SA-1254 V1: the five plan-key mirrors keep one order (T13)", () => {
  it("the shared package's PLAN_KEYS equals the API's, in order", () => {
    expect([...shared.PLAN_KEYS]).toEqual([...PLAN_KEYS]);
  });

  it("the JS mirror's PLAN_KEYS equals the API's, in order", () => {
    expect(mirror.PLAN_KEYS).toEqual([...PLAN_KEYS]);
    expect(mirror.LEGACY_PLAN_KEY_ALIASES).toEqual(LEGACY_PLAN_KEY_ALIASES);
  });

  it("the JS mirror's planKeyFromEnum and normalizePlanKey equal the TypeScript for every probe", () => {
    for (const v of PROBES) {
      expect(`${label(v)} -> ${mirror.planKeyFromEnum(v)}`).toBe(
        `${label(v)} -> ${planKeyFromEnum(v)}`,
      );
      expect(`${label(v)} -> ${mirror.normalizePlanKey(v)}`).toBe(
        `${label(v)} -> ${normalizePlanKey(v)}`,
      );
    }
  });

  it("report-noop-addons normalizePlan maps forward like the TypeScript and passes unknown keys through", () => {
    const href = pathToFileURL(path.resolve(API_DIR, "scripts/report-noop-addons.mjs")).href;
    const probes = JSON.stringify(PROBES);
    const out = runModule(
      `const m = await import(${JSON.stringify(href)});` +
        `const probes = ${probes};` +
        `console.log(JSON.stringify(Object.fromEntries(probes.map((p) => [String(p), m.normalizePlan(p)]))));`,
    );
    for (const v of PROBES) {
      const want = v == null ? "STARTER" : (normalizePlanKey(v) ?? v);
      expect(`${label(v)} -> ${String(out[String(v)])}`).toBe(`${label(v)} -> ${want}`);
    }
  });

  it("backfill-subscription-reconciliation reads its alias map from the JS mirror", () => {
    const href = pathToFileURL(
      path.resolve(API_DIR, "scripts/backfill-subscription-reconciliation.mjs"),
    ).href;
    const out = runModule(
      `const m = await import(${JSON.stringify(href)});` +
        `console.log(JSON.stringify({ aliases: m.LEGACY_PLAN_KEY_ALIASES }));`,
    );
    expect(out.aliases).toEqual(LEGACY_PLAN_KEY_ALIASES);
  });

  /**
   * T27 / C2b inventory: only the JS mirror may type the plan-key helpers. A script that needs
   * them requires lib/feature-registry-mirror.cjs. Scans apps/api/scripts and scripts.
   */
  it("the inventory sees a hand copy however its alias map and key order are spelled (R-56 F1)", () => {
    const QUOTED_ALIAS = 'const ALIASES = { "TEAM": "GROWTH", BUSINESS: "SCALE" };';
    const RENAMED_ORDER =
      'const PROBE_ORDER = ["LITE", "STARTER", "GROWTH", "SCALE", "ENTERPRISE"];';
    const SINGLE_QUOTED = "const ORDER = ['STARTER', 'CORE', 'GROWTH'];";
    expect(inventoryHits(QUOTED_ALIAS)).toContain('TEAM: "GROWTH"');
    expect(inventoryHits(RENAMED_ORDER)).toContain("a plan-key order array");
    expect(inventoryHits(SINGLE_QUOTED)).toContain("a plan-key order array");
    expect(INVENTORY_FILE.test("copy.ts")).toBe(true);
    // one key alone, or keys out of ladder order, is not a copy of the order
    expect(inventoryHits('if (key === "STARTER") return "GROWTH";')).toEqual([]);
    expect(inventoryHits('const OUT = ["SCALE", "STARTER"];')).toEqual([]);
  });

  it("only lib/feature-registry-mirror.cjs types the plan-key helpers under the script trees", () => {
    const PATTERNS = INVENTORY_PATTERNS;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (INVENTORY_FILE.test(name)) files.push(full);
      }
    };
    walk(path.join(API_DIR, "scripts"));
    walk(path.join(REPO_ROOT, "scripts"));
    expect(files.length).toBeGreaterThan(50); // not vacuous

    const hits = new Set<string>();
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const [name, re] of PATTERNS) {
        if (re.test(src)) {
          hits.add(`${path.relative(REPO_ROOT, file).split(path.sep).join("/")}: ${name}`);
        }
      }
    }
    const MIRROR = "apps/api/scripts/lib/feature-registry-mirror.cjs";
    expect([...hits].filter((h) => !h.startsWith(`${MIRROR}:`))).toEqual([]);
    // and the mirror itself still carries all four (the scan can see it)
    expect([...hits].filter((h) => h.startsWith(`${MIRROR}:`))).toHaveLength(PATTERNS.length);
  });
});
