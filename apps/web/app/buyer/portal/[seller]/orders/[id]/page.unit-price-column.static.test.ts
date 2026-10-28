import { readFileSync } from "fs";
import { join } from "path";

/**
 * B1266: at 390 px the Unit Price header and the read-only row hide (`max-sm:hidden`), so every other
 * Unit Price cell in the same table must hide too, or the price slides under the Subtotal header.
 * Source pin (the page is too heavy to mount): each `<td>` that renders `fmt(<line>.unitPrice)` carries it.
 */
const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("buyer order lines table: Unit Price column hides as one at 390 px (B1266)", () => {
  it("hides the header", () => {
    expect(src).toMatch(/<th[^>]*max-sm:hidden[^>]*>Unit Price<\/th>/);
  });

  it("hides every Unit Price cell, edit rows included", () => {
    const cells = [...src.matchAll(/<td([^>]*)>\s*\{(?:item\.unitPrice \? )?fmt\((?:Number\()?(?:item|li)\.unitPrice/g,
    )];
    expect(cells.length).toBeGreaterThanOrEqual(2);
    for (const c of cells) expect(c[1]).toContain("max-sm:hidden");
  });
});
