/**
 * Source pin for the invoice detail line "Amount" cell. The page is ~3k lines of hooks, so the
 * boxed-aware math is pinned on the shared helper (apps/web/lib/line-subtotal.test.ts) and this
 * file pins that the page uses it instead of re-deriving `qty * unitPrice`, which over-charges a
 * boxed line (qty = pieces, unitPrice = BOX price) by unitsPerBox.
 */
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("invoice detail page — line total fallback", () => {
  it("never re-derives qty x unitPrice for a line total", () => {
    expect(/Number\(item\.qty\)\s*\*\s*Number\(item\.unitPrice\)/.test(source)).toBe(false);
  });

  it("routes the line Amount cell through storedOrComputedLineSubtotal", () => {
    expect(source.includes("storedOrComputedLineSubtotal(item)")).toBe(true);
  });
});
