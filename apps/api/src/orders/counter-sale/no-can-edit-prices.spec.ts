import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * SA-762r Ruling A: price editing has ONE helper, `staffMay(role, "EDIT_LINE_PRICE")`. A second predicate named
 * `canEditPrices` is how the table forks (the old counter copy was admin-only, the rest of the app let an operator
 * reprice). This pins that no source file in the API or the shared packages defines one again. (The web copy,
 * apps/web/lib/can-edit-prices.ts, is deleted in the web PR.)
 */
const ROOTS = [join(__dirname, "../.."), join(__dirname, "../../../../../packages")];
const DEFINES =
  /\b(?:function\s+canEditPrices\b|(?:const|let|var)\s+canEditPrices\b|canEditPrices\s*[:=]\s*(?:async\s*)?(?:\(|function))/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith("no-can-edit-prices.spec.ts"))
      out.push(full);
  }
  return out;
}

describe("no canEditPrices is defined anywhere (SA-762r)", () => {
  it("scans the api and packages sources, and finds no definition", () => {
    const files = ROOTS.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(500);
    const offenders = files.filter((f) => DEFINES.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the pattern would catch a definition (guards against a vacuous scan)", () => {
    expect(DEFINES.test("export function canEditPrices(user) {}")).toBe(true);
    expect(DEFINES.test("export const canEditPrices = (u) => true;")).toBe(true);
    expect(DEFINES.test("const staffMay = 1; // canEditPrices was deleted")).toBe(false);
  });

  it("the counter passes through staffMay", () => {
    const src = readFileSync(join(__dirname, "counter-sale.service.ts"), "utf8");
    expect(src).toContain('staffMay(user.role, "EDIT_LINE_PRICE")');
  });
});
