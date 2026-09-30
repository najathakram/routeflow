import { readFileSync } from "fs";
import { join } from "path";

// RN screens aren't renderable in this jest lane (pure-logic only), so the wiring is
// source-pinned, the same way po-detail-unit-display-wiring.test.ts pins the detail screen.
// #2734: a PO line stored at pack 12 on a product later repacked to 6 must receive at 12. The
// detail screen already resolves the pack through linePack (stored wins); the receive form read
// item.product.unitsPerBox (the LIVE pack), so it seeded and labelled boxes at 6.
describe("PO receive screen: the line's stored pack wins (#2734)", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(operator)/purchase-orders/[id]/receive.tsx"),
    "utf8",
  );

  it("imports linePack from @routeflow/pricing", () => {
    expect(src).toMatch(/import\s*\{[^}]*\blinePack\b[^}]*\}\s*from\s*"@routeflow\/pricing"/);
  });

  it("resolves the pack through linePack(item, live), never off the live product alone", () => {
    expect(src).toMatch(/linePack\(\s*item\s*,/);
    // The old shape: upbOf returned the live product's unitsPerBox directly.
    expect(src).not.toMatch(
      /Math\.trunc\(\s*Number\(\s*item\.product\?\.unitsPerBox\s*\?\?\s*0\s*\)\s*\)\s*;/,
    );
  });

  it("accepts the line's own packSize in upbOf's parameter type", () => {
    expect(src).toMatch(/upbOf\s*=\s*\(\s*item:\s*\{[^}]*packSize\?:/);
  });
});
