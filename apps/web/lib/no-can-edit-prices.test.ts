import * as fs from "fs";
import * as path from "path";

/**
 * SA-762r Ruling A: the counter's price-edit gate is `staffMay(role, "EDIT_LINE_PRICE")` from @routeflow/types and nothing
 * else. No web file may define a `canEditPrices` predicate (a second copy is how the role tables drifted), and the old
 * helper's file is gone. A `canEditPrices` PROP name (a boolean handed to a component) is not a definition.
 */
const WEB_ROOT = path.resolve(__dirname, "..");
const SKIP = new Set(["node_modules", ".next", ".jest-cache", ".turbo", "coverage"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) sources(abs, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(abs);
  }
  return out;
}

const DEFINES =
  /\b(?:function\s+canEditPrices\b|(?:const|let|var)\s+canEditPrices\b|export\s*\{[^}]*\bcanEditPrices\b[^}]*\}|from\s+["'][^"']*can-edit-prices["'])/;

describe("no web file defines canEditPrices (SA-762r)", () => {
  it("the old helper file is deleted", () => {
    expect(fs.existsSync(path.join(WEB_ROOT, "lib", "can-edit-prices.ts"))).toBe(false);
    expect(fs.existsSync(path.join(WEB_ROOT, "lib", "can-edit-prices.test.ts"))).toBe(false);
  });

  it("no source defines or imports a canEditPrices predicate", () => {
    const self = path.basename(__filename);
    const offenders = sources(WEB_ROOT)
      .filter((f) => path.basename(f) !== self)
      .filter((f) => DEFINES.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(WEB_ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("the counter screen gates the price control through staffMay", () => {
    const screen = fs.readFileSync(
      path.join(WEB_ROOT, "app/(dashboard)/orders/_components/CounterSaleScreen.tsx"),
      "utf8",
    );
    expect(screen).toMatch(/staffMay\(\s*authUser\?\.role,\s*"EDIT_LINE_PRICE"\s*\)/);
  });
});
