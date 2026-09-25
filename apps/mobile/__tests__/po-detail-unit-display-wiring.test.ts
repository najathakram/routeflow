import { readFileSync } from "fs";
import { join } from "path";

// RN screens aren't renderable in this jest lane (pure-logic only), so the wiring is
// source-pinned: the PO detail screen must import unitsLabel + linePack from
// @routeflow/pricing (the one shared pair — a local mobile copy of unitsLabel got repacked/
// un-boxed lines wrong, since it never went through linePack's stored-wins rule at all) and
// resolve the split's pack through linePack(item, ...), never off item.product?.unitsPerBox
// directly (#2066 review round).
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

  it("passes the item's own product.unit as the non-boxed unit noun, matching web", () => {
    const unitAssign = src.match(/const\s+unit\s*=\s*([^;]+);/);
    expect(unitAssign).not.toBeNull();
    expect(unitAssign![1]).toMatch(/item\.product\?\.unit\b/);
  });

  it("every qtyLabel call site feeds the resolved upb, not a raw product.unitsPerBox read", () => {
    const qtyLabelFn = src.match(/const\s+qtyLabel\s*=\s*\([^)]*\)\s*=>\s*([^;]+);/);
    expect(qtyLabelFn).not.toBeNull();
    expect(qtyLabelFn![1]).toMatch(/unitsLabel\(\s*qty\s*,\s*upb\s*,\s*unit\s*\)/);
  });
});
