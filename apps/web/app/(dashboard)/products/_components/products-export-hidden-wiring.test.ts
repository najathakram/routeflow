import * as fs from "fs";
import * as path from "path";

/**
 * N1 (#2856): the products list's "Hidden from portal" filter must reach the CSV export, or the button
 * shows the filtered count while the file exports everything. Source pin on the page's wiring (the page
 * is ~3k lines and not worth mounting for one prop).
 */
const src = fs.readFileSync(path.join(__dirname, "..", "page.tsx"), "utf8");

describe("products/page.tsx — export forwards the Hidden filter (N1)", () => {
  it("the ProductsExportButton filters spread portalVisibleFilterParam(hiddenOnly)", () => {
    const m = /<ProductsExportButton[\s\S]{0,400}?filters=\{\{([\s\S]*?)\}\}/.exec(src);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/\.\.\.portalVisibleFilterParam\(hiddenOnly\)/);
  });
});
