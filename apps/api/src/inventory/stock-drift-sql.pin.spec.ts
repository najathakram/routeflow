import { readFileSync } from "fs";
import * as path from "path";

/**
 * Row 635 (SA-902 MUST 1): ONE drift query. The standing guard (`stock-ledger-gap.mjs`) and the D1 backfill read drift
 * from `scripts/lib/stock-drift-sql.mjs`, so the gate and the backfill can never disagree on what drift is. Neither
 * script may carry its own Σ over StockMovement.
 */
const SCRIPTS = path.resolve(__dirname, "../../scripts");
const LIB = "./lib/stock-drift-sql.mjs";
const read = (f: string) => readFileSync(path.join(SCRIPTS, f), "utf8");
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("Row 635 MUST 1: the drift query lives in one module", () => {
  it("the module exports the listing query and the per-product re-read, both over every movement row", () => {
    const lib = read("lib/stock-drift-sql.mjs");
    expect(lib).toMatch(/export const DRIFTED_PRODUCTS_SQL = `/);
    expect(lib).toMatch(/export const PRODUCT_LEDGER_SQL = `/);
    expect(lib).toMatch(/p\."currentStock" - COALESCE\(m\.total, 0\) <> 0/);
  });

  it.each([
    ["stock-ledger-gap.mjs", ["DRIFTED_PRODUCTS_SQL"]],
    ["b562-d1-ledger-gap-backfill.mjs", ["DRIFTED_PRODUCTS_SQL", "PRODUCT_LEDGER_SQL"]],
  ])("%s imports the shared query and computes no Σ of its own", (file, names) => {
    const src = code(read(file));
    for (const name of names) {
      expect(src).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "${LIB}"`));
    }
    expect(src).not.toMatch(/SUM\(\s*quantity\s*\)/i);
    expect(src).not.toMatch(/"currentStock"\s*-\s*COALESCE/);
  });
});
