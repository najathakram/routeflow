import * as fs from "fs";
import * as path from "path";

/**
 * P02 pin: the base price has ONE name on the product page. Tier 1 prints through
 * `tierOneLabel` / `productTierLabel` (@/lib/tier-one-label): the tenant's own label, else "Retail".
 * A hard-coded "Tier 1" or a raw `tierLabel(..., 1)` is how the page said "Tier 1" in one place and
 * "Retail" in another.
 */
// Paths are relative to this folder. products/page.tsx (the list) joined with the K10b P02 completeness pass.
// TODO(K10c): add the customer-view files here when they land on this branch (not present on K10b).
const FILES = ["page.tsx", "ProductPricesGrid.tsx", "ProductUnitsCard.tsx", "../page.tsx"];
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (f: string) => stripComments(fs.readFileSync(path.join(__dirname, f), "utf8"));

describe.each(FILES)("%s", (file) => {
  const src = read(file);

  it("never prints a hard-coded 'Tier 1' label", () => {
    expect(src).not.toMatch(/["'`]Tier 1["'`]/);
    expect(src).not.toMatch(/>\s*Tier 1\s*</);
    expect(src).not.toMatch(/Tier 1\b/);
  });

  it("never asks the raw tierLabel for tier 1", () => {
    expect(src).not.toMatch(/\btierLabel\(\s*\w+\s*,\s*1\s*\)/);
    expect(src).not.toMatch(/t === 1 \? "Retail"/);
  });

  it("imports no raw tierLabel (the tier-1-aware helper is the only door)", () => {
    expect(src).not.toMatch(/import \{[^}]*\btierLabel\b[^}]*\} from "@\/lib\/tier-label"/);
  });
});

it("the grid, the page and the list page all use the shared helper", () => {
  for (const f of ["page.tsx", "ProductPricesGrid.tsx", "../page.tsx"]) {
    expect(read(f)).toMatch(/from "@\/lib\/tier-one-label"/);
  }
});
