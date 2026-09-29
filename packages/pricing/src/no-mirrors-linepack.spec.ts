import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

/**
 * #2066 / SA-555: `linePack` — the pack a purchase-order line is denominated in (the line's OWN
 * stored `packSize` wins; the live catalog pack is only the fallback, B699/B722) — has ONE home,
 * packages/pricing/src/pricing.ts. Mobile's PO detail screen once grew a local split that read the
 * LIVE `product.unitsPerBox` instead, silently re-denominating received lines after a repack.
 * This tripwire fails when app SOURCE (tests excluded — their fixtures are data) defines its own
 * `linePack`, so a local copy is a red build rather than a review catch. Web's
 * purchase-orders-shared.ts keeps a re-export under the original name, which is not a definition.
 * (A sibling of no-mirrors.spec.ts / no-mirrors-nsf.spec.ts, kept separate so they never conflict.)
 */
const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCAN_ROOTS = ["apps/api/src", "apps/api/scripts", "apps/web", "apps/mobile", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist"]);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST = /(\.spec\.|\.test\.|__tests__\/|\/e2e\/)/;
const WEB_REEXPORT = "apps/web/app/(dashboard)/inventory/_components/purchase-orders-shared.ts";
const MOBILE_PO_DETAIL = "apps/mobile/app/(operator)/purchase-orders/[id].tsx";

const DEFINITION = /\bfunction\s+linePack\s*[<(]|\b(?:const|let|var)\s+linePack\s*[:=]/;

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
    if (!existsSync(full)) throw new Error(`linePack no-mirrors scan root is missing: ${root}`);
    return walk(full).filter((f) => SOURCE.test(f) && !TEST.test(rel(f)));
  });
}

function offenders(): string[] {
  return scanned()
    .filter((file) => DEFINITION.test(readFileSync(file, "utf8")))
    .map(rel)
    .sort();
}

describe("linePack has one home: packages/pricing (#2066, SA-555)", () => {
  it("no app source defines its own linePack", () => {
    expect(offenders()).toEqual([]);
  });

  it("web re-exports the shared linePack and mobile's PO detail imports it", () => {
    const web = readFileSync(join(REPO_ROOT, WEB_REEXPORT), "utf8");
    expect(web).toMatch(/from "@routeflow\/pricing"/);
    expect(web).toMatch(/export \{ linePack \};/);
    const mobile = readFileSync(join(REPO_ROOT, MOBILE_PO_DETAIL), "utf8");
    expect(mobile).toMatch(/import \{[^}]*\blinePack\b[^}]*\} from "@routeflow\/pricing";/);
  });

  it("anti-vacuity: the pattern catches each definition shape and the scan reaches the consumers", () => {
    expect(DEFINITION.test("export function linePack(line, live) {")).toBe(true);
    expect(DEFINITION.test("const linePack = (l, p) => p;")).toBe(true);
    expect(DEFINITION.test("export const linePack: (l: X, p: number) => number = f;")).toBe(true);
    expect(DEFINITION.test('import { linePack } from "@routeflow/pricing";')).toBe(false);
    expect(DEFINITION.test("export { linePack };")).toBe(false);
    expect(DEFINITION.test("const upb = linePack(item, live);")).toBe(false);
    const files = scanned().map(rel);
    expect(files).toContain(WEB_REEXPORT);
    expect(files).toContain(MOBILE_PO_DETAIL);
  });
});
