/**
 * T3 (R5): no-mirrors tripwire.
 *
 * Once PR-4's codemod (`scripts/codemods/pricing-import-rewrite.mjs`) runs and
 * the `@routeflow/pricing` package lands, nothing under the three apps —
 * including their non-`src` script and test trees — may still reference a
 * legacy pricing mirror. Four checks feed one sorted offender list:
 *
 *   (a) none of the four legacy source files exists:
 *       `apps/api/src/common/pricing.ts`, `apps/api/src/utils/pricing.ts`,
 *       `apps/web/lib/pricing.ts`, `apps/mobile/lib/pricing.ts`
 *   (b) no source file under the scan roots (skipping `node_modules`,
 *       `.next`, `dist`) contains an import specifier matching one of the
 *       legacy shapes (relative `lib|common|utils` pricing paths — with or
 *       without an explicit `.ts` extension, as a CommonJS `require` from a
 *       script would write it — `@/lib/pricing`, or mobile's
 *       `../../web/lib/pricing` cross-app import). The roots cover the
 *       non-`src` importers too (`apps/api/scripts`, `apps/api/test`, root
 *       `scripts/`) and the walk reads `.js`/`.jsx`/`.mjs`/`.cjs` as well as
 *       `.ts`/`.tsx`, because a plain-JS consumer such as
 *       `apps/api/scripts/demo-seed.js` breaks on a deleted mirror exactly
 *       like a TypeScript one does
 *   (c) `apps/api/src` has no file named `pricing-parity.spec.ts` (its
 *       "mirror parity" describe reads the deleted files directly)
 *   (d) `turbo.json`'s text no longer names `apps/web/lib/pricing.ts` (the
 *       mirror-inputs block this PR removes)
 *
 * Before implementation: the four legacy files exist and ~125 imports across
 * the three apps still resolve to them, so the offender list is non-empty.
 * After PR-4 lands, it must be empty.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..");

const LEGACY_FILES = [
  "apps/api/src/common/pricing.ts",
  "apps/api/src/utils/pricing.ts",
  "apps/web/lib/pricing.ts",
  "apps/mobile/lib/pricing.ts",
];

const SCAN_ROOTS = [
  "apps/api/src",
  "apps/api/scripts",
  "apps/api/test",
  "apps/web",
  "apps/mobile",
  "scripts",
];

const SKIP_DIRS = new Set(["node_modules", ".next", "dist"]);

// `scripts/codemods/*` are one-time migration/verification tools whose entire job is to
// match legacy pricing import strings as literal data (to rewrite them, or diff against
// them) — they are not live consumers of pricing math, so they are expected to keep
// referencing the legacy shapes forever, the same way `pricing-parity.spec.ts` was a
// deliberate, separately-excluded exception before it was deleted outright.
const SCAN_EXCLUDE_PREFIXES = ["scripts/codemods/"];

const SOURCE_FILE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

const IMPORT_PATTERNS = [
  /["'](\.{1,2}\/)+(lib|common|utils)\/pricing["']/,
  /["']@\/lib\/pricing["']/,
  /["']\.\.\/\.\.\/web\/lib\/pricing["']/,
  // A `require("../src/common/pricing.ts")` from apps/api/scripts — an explicit
  // extension and an intermediate `src/` segment that the first pattern misses.
  /["'](\.{1,2}\/)+(src\/)?(lib|common|utils)\/pricing(\.ts)?["']/,
];

const PRICING_PARITY_SPEC = "apps/api/src/common/pricing-parity.spec.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(REPO_ROOT, file).split(sep).join("/");

function collectSourceFiles(root: string): string[] {
  const full = join(REPO_ROOT, root);
  // A missing root must FAIL, never silently contribute zero files — a renamed
  // or mistyped root would otherwise make every check below pass vacuously.
  if (!existsSync(full)) throw new Error(`no-mirrors scan root is missing: ${root}`);
  return walk(full)
    .filter((file) => SOURCE_FILE_PATTERN.test(file))
    .filter((file) => !SCAN_EXCLUDE_PREFIXES.some((prefix) => rel(file).startsWith(prefix)));
}

/** Every file the import scan actually reads, as repo-relative paths. */
function collectScannedFiles(): string[] {
  return SCAN_ROOTS.flatMap((root) => collectSourceFiles(root)).map(rel);
}

/** Same offender test the combined tripwire uses, factored out so the
 * anti-vacuity check below exercises the identical walk + pattern-match
 * pipeline as the real scan. */
function findLegacyImportOffenders(): string[] {
  const offenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of collectSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      if (IMPORT_PATTERNS.some((pattern) => pattern.test(source))) {
        offenders.push(rel(file));
      }
    }
  }
  return offenders;
}

function findLegacyFileOffenders(): string[] {
  return LEGACY_FILES.filter((path) => existsSync(join(REPO_ROOT, path)));
}

function findPricingParitySpecOffender(): string[] {
  return existsSync(join(REPO_ROOT, PRICING_PARITY_SPEC)) ? [PRICING_PARITY_SPEC] : [];
}

function findTurboJsonOffender(): string[] {
  const turboJson = readFileSync(join(REPO_ROOT, "turbo.json"), "utf8");
  return turboJson.includes("apps/web/lib/pricing.ts") ? ["turbo.json"] : [];
}

function findAllOffenders(): string[] {
  return [
    ...findLegacyFileOffenders(),
    ...findLegacyImportOffenders(),
    ...findPricingParitySpecOffender(),
    ...findTurboJsonOffender(),
  ].sort();
}

describe("pricing mirrors are gone (T3, R5)", () => {
  it("has none of the four legacy pricing mirror files", () => {
    expect(findLegacyFileOffenders().sort()).toEqual([]);
  });

  it("has no source import specifier pointing at a legacy pricing mirror", () => {
    expect(findLegacyImportOffenders().sort()).toEqual([]);
  });

  it("no longer has apps/api/src/common/pricing-parity.spec.ts (it read the deleted mirrors directly)", () => {
    expect(findPricingParitySpecOffender()).toEqual([]);
  });

  it("turbo.json no longer names apps/web/lib/pricing.ts (the removed mirror-inputs block)", () => {
    expect(findTurboJsonOffender()).toEqual([]);
  });

  it("combines all four checks into one sorted offender list that is empty", () => {
    expect(findAllOffenders()).toEqual([]);
  });

  it("anti-vacuity: the import scan actually reads a non-empty set of files today", () => {
    // Guards against the walk silently reading nothing (a config typo that
    // skips every root would make every check above pass for the wrong
    // reason). Independent of the pricing mirrors: apps/api/src always has
    // TypeScript files.
    expect(collectSourceFiles("apps/api/src").length).toBeGreaterThan(0);
  });

  it("anti-vacuity: the scan reaches the non-src script roots and plain-JS files", () => {
    // The blind spots this tripwire was widened to cover: a consumer outside
    // `<app>/src` (apps/api/scripts) and a consumer that is not TypeScript.
    // Without these, narrowing SCAN_ROOTS or the extension filter back would
    // leave the suite green while a live importer is broken.
    const scanned = collectScannedFiles();
    expect(scanned.filter((file) => file.startsWith("apps/api/scripts/")).length).toBeGreaterThan(
      0,
    );
    expect(scanned.filter((file) => /\.(js|jsx|mjs|cjs)$/.test(file)).length).toBeGreaterThan(0);
  });
});
