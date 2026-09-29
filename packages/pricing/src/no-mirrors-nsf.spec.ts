import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

/**
 * #2392 / SA-478 (A): the NSF fee-line predicate and its description prefix have ONE home,
 * packages/pricing/src/nsf-line.ts. This tripwire fails when app SOURCE (tests excluded — their
 * fixture strings are data) defines its own `NSF_FEE_DESCRIPTION_PREFIX =`, hand-copies the prefix
 * string, or declares its own `isNsfLine` — except the API's delegating wrapper
 * (apps/api/src/invoices/nsf-line.ts), which must call the shared `isNsfLineFacts`.
 * (A sibling of no-mirrors.spec.ts, kept separate so the two files never conflict.)
 */
const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCAN_ROOTS = ["apps/api/src", "apps/api/scripts", "apps/web", "apps/mobile", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist"]);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST = /(\.spec\.|\.test\.|__tests__\/|\/e2e\/)/;
const API_WRAPPER = "apps/api/src/invoices/nsf-line.ts";

const PREFIX_DEFINITION = /\bNSF_FEE_DESCRIPTION_PREFIX\s*[:=]\s*["'`]/;
const PREFIX_LITERAL = /NSF fee — returned check/;
const PREDICATE_DEFINITION = /\bfunction\s+isNsfLine\s*[<(]|\b(?:const|let|var)\s+isNsfLine\s*[:=]/;
// #2656 / SA-549: the goods-only inferred rate has one home too. App source calls
// inferredGoodsFlatRate; a direct inferredFlatRate( call is how the 3 unrounded copies were written.
const GOODS_RATE_DEFINITION =
  /\bfunction\s+inferredGoodsFlatRate\s*[<(]|\b(?:const|let|var)\s+inferredGoodsFlatRate\s*[:=]/;
const DIRECT_INFERENCE = /\binferredFlatRate\s*\(/;

const rel = (f: string) => relative(REPO_ROOT, f).split(sep).join("/");
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
function scanned(): string[] {
  return SCAN_ROOTS.flatMap((root) => {
    const full = join(REPO_ROOT, root);
    if (!existsSync(full)) throw new Error(`nsf no-mirrors scan root is missing: ${root}`);
    return walk(full).filter((f) => SOURCE.test(f) && !TEST.test(rel(f)));
  });
}

function offenders(): string[] {
  const out: string[] = [];
  for (const file of scanned()) {
    const r = rel(file);
    const text = readFileSync(file, "utf8");
    if (PREFIX_DEFINITION.test(text) || PREFIX_LITERAL.test(text)) out.push(`${r}: NSF prefix`);
    if (PREDICATE_DEFINITION.test(text) && r !== API_WRAPPER) out.push(`${r}: isNsfLine`);
    if (GOODS_RATE_DEFINITION.test(text)) out.push(`${r}: inferredGoodsFlatRate`);
    if (DIRECT_INFERENCE.test(text)) out.push(`${r}: direct inferredFlatRate(`);
  }
  return out.sort();
}

describe("the NSF predicate and prefix have one home: packages/pricing (#2392, SA-478)", () => {
  it("no app source defines or hand-copies them", () => {
    expect(offenders()).toEqual([]);
  });

  it("the API's isNsfLine is a delegating wrapper around the shared predicate", () => {
    const wrapper = readFileSync(join(REPO_ROOT, API_WRAPPER), "utf8");
    expect(wrapper).toMatch(/from "@routeflow\/pricing"/);
    expect(wrapper).toMatch(/return isNsfLineFacts\(line, hasTransitionLeg\);/);
  });

  it("anti-vacuity: the patterns catch each mirror shape and the scan reaches the former copies", () => {
    expect(PREFIX_DEFINITION.test('const NSF_FEE_DESCRIPTION_PREFIX = "x";')).toBe(true);
    expect(PREFIX_LITERAL.test('startsWith("NSF fee — returned check")')).toBe(true);
    expect(PREDICATE_DEFINITION.test("export function isNsfLine(l) {")).toBe(true);
    expect(PREDICATE_DEFINITION.test('import { isNsfLine } from "@routeflow/pricing";')).toBe(
      false,
    );
    const files = scanned().map(rel);
    expect(files).toContain("apps/api/scripts/backfill-2169-nsf-system-kind.mjs");
    expect(files).toContain("apps/api/src/sales-agents/commission-math.ts");
    expect(files).toContain("apps/mobile/lib/invoice-edit-tax.ts");
    // #2656: the goods-rate patterns, and the scan reaches all three former copies.
    expect(GOODS_RATE_DEFINITION.test("export function inferredGoodsFlatRate(live) {")).toBe(true);
    expect(DIRECT_INFERENCE.test("const r = inferredFlatRate({ subtotal })")).toBe(true);
    expect(DIRECT_INFERENCE.test("const r = inferredGoodsFlatRate({ subtotal })")).toBe(false);
    expect(files).toContain("apps/api/src/invoices/price-adjustment-ledger.ts");
    expect(files).toContain("apps/api/scripts/backfill-b294-order-line-taxrate.mjs");
  });
});
