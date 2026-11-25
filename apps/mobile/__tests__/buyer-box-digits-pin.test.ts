import { readFileSync } from "fs";
import { join } from "path";

/**
 * B1409 (R-153-D L2): the buyer quantity box rejects "-5", "12.5" and "1e9" whole only while the two customer screens
 * pass `rejectNonDigits`. Mobile Jest is pure-logic, so this pins the source (same pattern as row-layout.test.ts):
 * deleting the prop from either screen turns it red. The limit itself comes from the cart store, never a literal.
 */
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("rejectNonDigits stays on the buyer quantity box", () => {
  it.each([
    ["catalog", "app/(customer)/(tabs)/catalog.tsx"],
    ["cart", "app/(customer)/orders/cart.tsx"],
  ])("the %s screen passes rejectNonDigits to its QtyTextInput", (_n, rel) => {
    const src = read(rel);
    const boxes = src.match(/<QtyTextInput[\s\S]*?\/>/g) ?? [];
    expect(boxes.some((b) => /\brejectNonDigits\b/.test(b) && /\bmax=\{/.test(b))).toBe(true);
  });
});

describe("no literal buyer line limit in the mobile callers (#4509 F5)", () => {
  it.each([
    ["store/cartStore.ts", "BUYER_LINE_QTY_MAX"],
    ["components/QtyStepper.tsx", ""],
    ["app/(customer)/(tabs)/catalog.tsx", ""],
    ["app/(customer)/orders/cart.tsx", ""],
  ])("%s has no 100000 literal", (rel, needle) => {
    const src = read(rel);
    if (needle) expect(src).toContain(needle);
    expect(src).not.toMatch(/100_?000/);
  });
});
