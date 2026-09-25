import { readFileSync } from "fs";
import { join } from "path";

// RN screens aren't renderable in this jest lane (pure-logic only), so the wiring is
// source-pinned: the PO detail screen must import unitsLabel + linePack from
// @routeflow/pricing (the one shared pair — a local mobile copy of unitsLabel got repacked/
// un-boxed lines wrong, since it never went through linePack's stored-wins rule at all),
// resolve the split's pack through linePack(item, ...), never off item.product?.unitsPerBox
// directly, and — a non-boxed line — render the bare number exactly like web's
// PurchaseOrdersTab (isBoxed ? unitsLabel(...) : ordered), never appending the live
// product's `unit` noun: a legacy line on a product later un-boxed can still carry a stale
// box noun ("case") on the live product, which read as "1,240 case" (looks like 1,240
// CASES) before this round (#2066 review round).
describe("PO detail screen: shared unitsLabel/linePack import + stored-pack wiring (#2066 review round)", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(operator)/purchase-orders/[id].tsx"),
    "utf8",
  );

  it("imports unitsLabel and linePack from @routeflow/pricing", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\blinePack\b[^}]*\bunitsLabel\b[^}]*\}\s*from\s*"@routeflow\/pricing"|import\s*\{[^}]*\bunitsLabel\b[^}]*\blinePack\b[^}]*\}\s*from\s*"@routeflow\/pricing"/,
    );
  });

  it("does not import the retired local po-item-qty-label module", () => {
    expect(src).not.toMatch(/po-item-qty-label/);
  });

  it("resolves the split's pack through linePack(item, ...), not item.product?.unitsPerBox directly", () => {
    const upbAssign = src.match(/const\s+upb\s*=\s*([^;]+);/);
    expect(upbAssign).not.toBeNull();
    expect(upbAssign![1]).toMatch(/linePack\(\s*item\s*,/);
  });

  it("a non-boxed line renders the bare qty — never unitsLabel(qty, upb, item.product?.unit)", () => {
    // The bug this guards: appending the live product's unit noun to a bare piece count
    // ("1,240 case") on a line whose product was later un-boxed but still carries the old
    // box-noun on `product.unit`.
    expect(src).not.toMatch(/unitsLabel\(\s*qty\s*,\s*upb\s*,\s*(unit|item\.product\?\.unit)\s*\)/);
  });

  it("qtyLabel is boxed ? unitsLabel(qty, upb) : qty — matching web's isBoxed ternary exactly", () => {
    const qtyLabelFn = src.match(/const\s+qtyLabel\s*=\s*\([^)]*\)\s*=>\s*\(([^;]+)\);/);
    expect(qtyLabelFn).not.toBeNull();
    expect(qtyLabelFn![1]).toMatch(/isBoxed\s*\?\s*unitsLabel\(\s*qty\s*,\s*upb\s*\)\s*:\s*qty/);
  });

  it("isBoxed is derived from the resolved upb, not a raw product.unitsPerBox read", () => {
    const isBoxedAssign = src.match(/const\s+isBoxed\s*=\s*([^;]+);/);
    expect(isBoxedAssign).not.toBeNull();
    expect(isBoxedAssign![1]).toMatch(/upb\s*>\s*1/);
  });
});
