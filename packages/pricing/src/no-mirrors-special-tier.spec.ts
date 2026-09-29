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

/**
 * One detector PER SHAPE of the special-tier test (SA-588b). Every shape has its own synthetic
 * positives, its own false-positive guards, and its own "no app source contains it" test, so a
 * blind spot in one shape cannot hide behind another. Shapes other than `define` only count on
 * a line that names a tier and is not a `.length` check.
 */
interface Shape {
  name: string;
  re: RegExp;
  positives: string[];
  negatives: string[];
  needsTier: boolean;
}

const SHAPES: Shape[] = [
  {
    name: "local isSpecialTier definition",
    re: /\b(?:const|let|var|function)\s+isSpecialTier\b/,
    needsTier: false,
    positives: [
      "export const isSpecialTier = (t: number) => t !== 1;",
      "function isSpecialTier(t) {",
    ],
    negatives: ["const ok = isSpecialTier(tier);", "import { isSpecialTier } from 'x';"],
  },
  {
    name: "ident !== 1",
    re: /\b[\w.]*[tT]ier\w*\s*!==?\s*1\b/,
    needsTier: false,
    positives: ["const special = ctx.tier !== 1;", "if (tierForProduct !== 1) {", "x: tier != 1,"],
    negatives: [
      "const ok = tier === 1;",
      "if (items.length !== 1) return;",
      "const b = tier !== 12;",
    ],
  },
  {
    name: "(x ?? 1) !== 1",
    re: /\?\?\s*1\s*\)\s*!==?\s*1\b/,
    needsTier: true,
    positives: [
      "const s = (cpMap.get(p.id) ?? customerTier ?? 1) !== 1;",
      "const s = (tier ?? 1) != 1;",
    ],
    negatives: ["const t = cpMap.get(p.id) ?? customerTier ?? 1;", "const q = (qty ?? 1) !== 1;"],
  },
  {
    name: "fn(x) !== 1",
    re: /\w\([^()]*\)\s*!==?\s*1\b/,
    needsTier: true,
    positives: ["const s = effectiveTierFor(id) !== 1;", "const s = Number(tier) !== 1;"],
    negatives: [
      "const s = effectiveTierFor(id);",
      "const s = list.indexOf(x) !== 1;",
      "if (items.length !== 1) {",
    ],
  },
  {
    name: "x > 1",
    re: /[\w)]\s*>\s*1\b(?![.\d])/,
    needsTier: true,
    positives: ["const s = tierForProduct > 1;", "? (tier > 1)"],
    negatives: [
      "if (qty > 1) plural = true;",
      "if (tiers.length > 1) render();",
      "const x = tier > 1.5 ? a : b;",
    ],
  },
  {
    name: "1 !== x / 1 < x",
    re: /(?<![\w.])1\s*(?:!==?|<)(?![=\d])\s*[\w.(]*[tT]ier/,
    needsTier: true,
    positives: [
      "const s = 1 !== customer.pricingTier;",
      "const s = 1 < pricingTier;",
      "1 != tierFor(p)",
    ],
    negatives: ["const s = 1 === tier;", "const s = 1 < qty && tierLabel;"],
  },
  {
    name: "!(x === 1)",
    re: /!\s*\([^;]*===?\s*1\b(?![.\d])/,
    needsTier: true,
    positives: ["const s = !(tier === 1);", "const s = !(getTier(p) == 1);"],
    negatives: [
      "const s = tier === 1;",
      "if (!(qty === 1)) x();",
      "const s = !isSpecialTier(tier);",
    ],
  },
];

export function findShape(shape: Shape, source: string): string[] {
  return source
    .split("\n")
    .filter((line) => {
      if (shape.needsTier && (!/tier/i.test(line) || /\.length\b/.test(line))) return false;
      return shape.re.test(line);
    })
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
  const files: string[] = [];
  for (const r of ROOTS) walk(join(REPO_ROOT, r), files);
  const sources = files.map((f) => ({
    rel: relative(REPO_ROOT, f).split(sep).join("/"),
    text: readFileSync(f, "utf8"),
  }));

  it("scans a real tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  describe.each(SHAPES)("shape: $name", (shape) => {
    it("detector flags its synthetic copies (non-vacuous)", () => {
      for (const line of shape.positives) expect(findShape(shape, line)).toHaveLength(1);
    });

    it("detector ignores unrelated comparisons (false-positive guards)", () => {
      for (const line of shape.negatives) expect(findShape(shape, line)).toHaveLength(0);
    });

    it("no app source contains this shape", () => {
      const offenders: string[] = [];
      for (const { rel, text } of sources) {
        for (const line of findShape(shape, text)) offenders.push(`${rel}: ${line}`);
      }
      expect(offenders.sort()).toEqual([]);
    });
  });
});
