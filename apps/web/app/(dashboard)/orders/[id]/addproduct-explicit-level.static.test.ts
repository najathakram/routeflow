/**
 * #2717 M4a-1: the order-edit page's addProduct must hand scan.bumpLineForScan the EXPLICIT level
 * (undefined for a shared code, so it bumps +1 like a tap), never the resolved `level` (which
 * would turn a shared-code scan into a whole-case add on a boxSplit line). Source pin: the helper
 * is unit-tested, the page wiring is not renderable cheaply.
 */
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("orders/[id] addProduct passes the explicit bump level (#2717)", () => {
  it("declares an explicit level parameter distinct from the resolved one", () => {
    expect(src).toMatch(
      /function addProduct\(\s*p: any,\s*level\?: scan\.SellLevel,\s*explicit\?: scan\.SellLevel,?/,
    );
  });

  it("bumpLineForScan receives `explicit`, not the resolved `level`", () => {
    const at = src.indexOf("function addProduct(");
    const body = src.slice(at, src.indexOf("\n  }\n", at));
    expect(body).toMatch(/scan\.bumpLineForScan\(it, unitScan, explicit\)/);
    expect(body).not.toMatch(/scan\.bumpLineForScan\(it, unitScan, level\)/);
  });
});
