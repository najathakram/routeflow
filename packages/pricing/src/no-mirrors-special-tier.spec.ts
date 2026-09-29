/**
 * #2696(c) / SA-588 — no-mirrors pin for the special-tier rule. "A tier other than 1 is a SPECIAL
 * line" lives ONCE, as `isSpecialTier` in `@routeflow/pricing`; api, web and mobile import it.
 * Any local definition or inline `tier !== 1` copy in non-spec app source fails this spec.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const ROOTS = ["apps/api/src", "apps/web", "apps/mobile"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "__tests__", "e2e"]);
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(spec|test)\.[tj]sx?$/;

const COPY_PATTERNS: RegExp[] = [
  /\b(?:const|let|var|function)\s+isSpecialTier\b/,
  /\b[\w.]*[tT]ier\w*\s*!==?\s*1\b/,
  /\b1\s*!==?\s*[\w.]*[tT]ier\w*\b/,
];

export function findSpecialTierCopies(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => COPY_PATTERNS.some((re) => re.test(line)))
    .map((l) => l.trim());
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(name) && !TEST_FILE.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
}

describe("no-mirrors: the special-tier rule (isSpecialTier)", () => {
  it("detector is non-vacuous on synthetic copies", () => {
    expect(
      findSpecialTierCopies("export const isSpecialTier = (t: number) => t !== 1;"),
    ).toHaveLength(1);
    expect(findSpecialTierCopies("const special = ctx.tier !== 1;")).toHaveLength(1);
    expect(findSpecialTierCopies("if (tierForProduct !== 1) {")).toHaveLength(1);
    expect(findSpecialTierCopies("isSpecialTier: tier != 1,")).toHaveLength(1);
    expect(findSpecialTierCopies("const ok = isSpecialTier(tier);")).toHaveLength(0);
  });

  it("no app source defines or inlines the tier-!==-1 rule", () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(join(REPO_ROOT, r), files);
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const f of files) {
      for (const line of findSpecialTierCopies(readFileSync(f, "utf8"))) {
        offenders.push(`${relative(REPO_ROOT, f).split(sep).join("/")}: ${line}`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});

/**
 * #2716c / SA-592 fold 1 — the half-cent staff price band lives ONCE, as
 * `withinStaffOverrideTolerance` in `@routeflow/pricing` (SA-588 decides it in 4-dp units; a raw
 * `Math.abs(a - b) <= 0.005` is float noise at the boundary). App source may not compare a price
 * against the half cent itself, nor import the tolerance constant to do so.
 */
const BAND_PATTERNS: RegExp[] = [
  /\bSTAFF_OVERRIDE_TOLERANCE\b/,
  /Math\.abs\([^)]*[pP]rice[^)]*\)\s*[<>]=?\s*0?\.005\b/,
];

export function findRawBandCompares(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => BAND_PATTERNS.some((re) => re.test(line)))
    .map((l) => l.trim());
}

describe("no-mirrors: the half-cent staff price band (withinStaffOverrideTolerance)", () => {
  it("detector is non-vacuous on synthetic copies", () => {
    expect(
      findRawBandCompares("if (Math.abs(overridePrice - stored.unitPrice) <= 0.005) return;"),
    ).toHaveLength(1);
    expect(
      findRawBandCompares("Math.abs(overridePrice - existingUnitPrice) > 0.005 &&"),
    ).toHaveLength(1);
    expect(findRawBandCompares("const near = d <= STAFF_OVERRIDE_TOLERANCE;")).toHaveLength(1);
    expect(findRawBandCompares("if (withinStaffOverrideTolerance(a, b)) return;")).toHaveLength(0);
    expect(findRawBandCompares("if (Math.abs(adjustments) < 0.005) adjustments = 0;")).toHaveLength(
      0,
    );
  });

  it("no app source compares a price against the half-cent band itself", () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(join(REPO_ROOT, r), files);
    const offenders: string[] = [];
    for (const f of files) {
      for (const line of findRawBandCompares(readFileSync(f, "utf8"))) {
        offenders.push(`${relative(REPO_ROOT, f).split(sep).join("/")}: ${line}`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});
