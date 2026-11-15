import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-1149 D2-8: every write of an existing line's quantity below what was delivered goes through ONE helper,
 * `assertQtyNotBelowDelivered`. Count pin: a new writer of an existing line's qty must call it (and bump this count).
 */
const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
const calls = (src: string) => src.match(/assertQtyNotBelowDelivered\(/g)?.length ?? 0;

describe("quantity floor call sites (SA-1149 D2-8)", () => {
  it("is defined once, in delivered-line-lock.ts", () => {
    expect(read("delivered-line-lock.ts")).toMatch(/export function assertQtyNotBelowDelivered\(/);
  });

  it.each([
    ["orders.service.ts", 1, "the per-line UPDATE, after normalizeBoxesPieces"],
    ["unit-line-edit.ts", 1, "updateUnitLine (unit-aware lines, non-substitute)"],
    ["delivered-stamp.ts", 1, "the replace-all recreated carry"],
  ])("%s calls it %i time(s): %s", (file, n) => {
    expect(calls(read(file))).toBe(n);
  });

  it("the per-line UPDATE call sits after the qty<=0 skip and before the price work", () => {
    const src = read("orders.service.ts");
    const skip = src.indexOf(
      "if (qty <= 0) continue;\n                assertQtyNotBelowDelivered(",
    );
    expect(skip).toBeGreaterThan(0);
  });
});
