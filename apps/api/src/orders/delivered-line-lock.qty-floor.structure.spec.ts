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

/** SA-1149 D2-21: the replace-all refusal is thrown once, in captureRecreatedCarry; both replace sites mark before they delete. */
describe("replace-all refusal sites (SA-1149 D2-21)", () => {
  it("ORDER_EDIT_DELIVERED_LINES is thrown from one helper, called at both exits of captureRecreatedCarry", () => {
    const src = read("delivered-stamp.ts");
    expect(src.match(/code: API_ERROR_CODES\.ORDER_EDIT_DELIVERED_LINES/g)).toHaveLength(1);
    expect(src.match(/throw deliveredLinesReplaced\(\)/g)).toHaveLength(2);
  });

  it("both replace sites call markLinesRecreated before their deleteMany (count 2)", () => {
    const src = read("orders.service.ts");
    expect(src.match(/markLinesRecreated\(tx, orderId, heldItems\)/g)).toHaveLength(2);
    const sites = [...src.matchAll(/markLinesRecreated\(tx, orderId, heldItems\)/g)].map(
      (m) => m.index!,
    );
    for (const at of sites) {
      expect(src.slice(at).indexOf("deleteMany")).toBeGreaterThan(0);
    }
  });
});
