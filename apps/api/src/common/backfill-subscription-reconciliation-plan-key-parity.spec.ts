import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LEGACY_PLAN_KEY_ALIASES,
  PLAN_KEYS,
  normalizePlanKey,
  findPlanDefinition,
} from "../billing/plan-catalog.constants";

/**
 * Parity pin (routeflow-c4 review of the legacy-plan-key-alias fix): backfill-subscription-
 * reconciliation.mjs re-types LEGACY_PLAN_KEY_ALIASES / normalizePlanKey / findPlanDefinition
 * by hand (as `normalizeLegacyPlanKey`/`findCatalogPlanKey`) because it cannot value-import
 * plan-catalog.constants.ts — no build step, see no-runtime-workspace-imports.spec.ts. A
 * hand-typed mirror silently drifting from its source of truth is exactly the class of bug
 * L-072 records, and this one decides which price lands in the MRR ledger, so it gets its own
 * pin — the same role enum-parity.spec.ts plays for packages/types/api/enums.ts vs
 * @prisma/client's generated enums.
 *
 * No database is touched. The .mjs export set is evaluated in ONE `node --input-type=module`
 * child that imports the real module by `file://` URL and prints one JSON line — ts-jest's
 * CommonJS transform can't `import` a `.mjs` file directly (same shim as railway-db-url.spec.ts
 * and backfill-legacy-tenant-ids-script.spec.ts).
 */

const API_DIR = path.resolve(__dirname, "..", "..");
const SCRIPT_HREF = pathToFileURL(
  path.resolve(API_DIR, "scripts/backfill-subscription-reconciliation.mjs"),
).href;

// Mirrors UNKNOWN_KEY_SLUG's stored value in backfill-subscription-reconciliation.db.spec.ts —
// a planKey no rename or alias table has ever heard of.
const UNKNOWN_KEY = "RETIRED_LEGACY_TIER";
const CATALOG_KEYS = [...PLAN_KEYS];
const KNOWN_KEYS = [...PLAN_KEYS, ...Object.keys(LEGACY_PLAN_KEY_ALIASES)];

interface ScriptResult {
  aliases: Record<string, string>;
  normalized: Record<string, string>;
  matched: Record<string, string | null>;
}

function runScript(): ScriptResult {
  const testKeys = [...KNOWN_KEYS, UNKNOWN_KEY];
  const script = `
    import { LEGACY_PLAN_KEY_ALIASES, normalizeLegacyPlanKey, findCatalogPlanKey } from "${SCRIPT_HREF}";
    const testKeys = ${JSON.stringify(testKeys)};
    const catalogKeys = ${JSON.stringify(CATALOG_KEYS)};
    const defs = new Map(catalogKeys.map((k) => [k, 1]));
    console.log(JSON.stringify({
      aliases: LEGACY_PLAN_KEY_ALIASES,
      normalized: Object.fromEntries(testKeys.map((k) => [k, normalizeLegacyPlanKey(k)])),
      matched: Object.fromEntries(testKeys.map((k) => [k, findCatalogPlanKey(defs, k) ?? null])),
    }));
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  if (res.status !== 0 || !res.stdout.trim()) {
    throw new Error(
      `backfill-subscription-reconciliation.mjs parity shim failed (status ${res.status}):\n` +
        `stdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
  return JSON.parse(res.stdout.trim()) as ScriptResult;
}

describe("backfill-subscription-reconciliation.mjs plan-key alias parity (L-072 sibling)", () => {
  const scriptResult = runScript();

  it("the .mjs's re-typed LEGACY_PLAN_KEY_ALIASES is deep-equal to plan-catalog.constants.ts's source of truth", () => {
    expect(scriptResult.aliases).toEqual(LEGACY_PLAN_KEY_ALIASES);
  });

  it.each(KNOWN_KEYS)("normalizeLegacyPlanKey(%s) matches normalizePlanKey(%s)", (key) => {
    expect(scriptResult.normalized[key]).toBe(normalizePlanKey(key));
  });

  it.each(KNOWN_KEYS)(
    "findCatalogPlanKey/findPlanDefinition resolve %s to the same catalog key",
    (key) => {
      const definitions = CATALOG_KEYS.map((planKey) => ({ planKey }));
      const expected = findPlanDefinition(definitions, key)?.planKey ?? null;
      expect(scriptResult.matched[key]).toBe(expected);
    },
  );

  it("an unknown key normalizes differently by design (pass-through vs null), but both lookups refuse it the same way", () => {
    // normalizeLegacyPlanKey has no validity notion -- it only narrows a KNOWN legacy name, so an
    // unrecognized key passes through unchanged. normalizePlanKey also validates against
    // PLAN_KEYS and returns null for anything it doesn't recognize. That divergence is by
    // design, not a parity bug -- what actually has to agree is what each catalog LOOKUP does
    // with the unresolved key, which is what the fix's correctness (and B327-style safety) rests
    // on: an unknown key must still land in the "not in the resolved catalog version" bucket.
    expect(scriptResult.normalized[UNKNOWN_KEY]).toBe(UNKNOWN_KEY);
    expect(normalizePlanKey(UNKNOWN_KEY)).toBeNull();

    const definitions = CATALOG_KEYS.map((planKey) => ({ planKey }));
    expect(scriptResult.matched[UNKNOWN_KEY]).toBeNull();
    expect(findPlanDefinition(definitions, UNKNOWN_KEY)).toBeUndefined();
  });
});
