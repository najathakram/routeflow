/**
 * SA-1098 A-1 / PR-S, row SE-13 — no-mirrors pin for the run-settlement figures. The expected cash,
 * the variance, the one-cent tolerance and the "needs a reason" rule live ONCE, in
 * `packages/pricing/src/run-settlement.ts`; the API, the web run page and the native screen import them.
 * A local definition of any of them in non-spec app source fails this spec. Mobile's `lib/run-settlement.ts`
 * re-exports them (`export { … }`), which is not a definition and passes.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const ROOTS = ["apps/api/src", "apps/web", "apps/mobile"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "__tests__", "e2e", ".next"]);
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(spec|test)\.[tj]sx?$/;

const NAMES = [
  "expectedPhysicalCash",
  "computeVariance",
  "isReconciled",
  "shouldForceSettlement",
  "varianceNeedsReason",
];
const DEFINITION = new RegExp(`\\b(?:const|let|var|function)\\s+(?:${NAMES.join("|")})\\b`);
// The tolerance written out inline: a variance compared against a cent in app code.
const INLINE_TOLERANCE = /Math\.abs\([^)]*[vV]ariance[^)]*\)\s*(?:<=|>)\s*0\.01\b/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(name) && !TEST_FILE.test(name)) out.push(full);
  }
}

function appSource(): string[] {
  const files: string[] = [];
  for (const root of ROOTS) walk(join(REPO_ROOT, root), files);
  return files;
}

describe("run-settlement no-mirrors (SE-13)", () => {
  it("the detector sees a local definition and an inline cent tolerance, and ignores a re-export or a call", () => {
    expect(DEFINITION.test("export function isReconciled(v: number) {")).toBe(true);
    expect(DEFINITION.test("const expectedPhysicalCash = (c) => c;")).toBe(true);
    expect(
      DEFINITION.test("export { computeVariance, isReconciled } from '@routeflow/pricing';"),
    ).toBe(false);
    expect(DEFINITION.test("const v = computeVariance(expected, counted);")).toBe(false);
    expect(INLINE_TOLERANCE.test("if (Math.abs(variance) > 0.01 && !reason) {")).toBe(true);
    expect(INLINE_TOLERANCE.test("return Math.abs(variance) <= 0.01;")).toBe(true);
    expect(INLINE_TOLERANCE.test("const gap = Math.abs(a - b) > 0.5;")).toBe(false);
  });

  it("no app source defines a settlement figure or writes the cent tolerance itself", () => {
    const hits: string[] = [];
    for (const file of appSource()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (DEFINITION.test(line) || INLINE_TOLERANCE.test(line)) {
          hits.push(`${relative(REPO_ROOT, file).split(sep).join("/")}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("the web form and the controls import the figures from the package", () => {
    for (const rel of [
      "apps/web/components/RunSettlementForm.tsx",
      "apps/web/lib/run-settlement-controls.ts",
    ]) {
      expect(readFileSync(join(REPO_ROOT, rel), "utf8")).toMatch(/from "@routeflow\/pricing"/);
    }
  });

  it("settleRun uses the shared rule", () => {
    // SA-1098 A-6: the settle transaction lives in run-settlement.ts.
    const service = readFileSync(join(REPO_ROOT, "apps/api/src/routes/run-settlement.ts"), "utf8");
    expect(service).toMatch(/varianceNeedsReason\(/);
  });
});
