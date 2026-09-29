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
