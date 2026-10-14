import * as fs from "fs";
import * as path from "path";

/**
 * Row 509 PR5: source pins on the catalog page's wiring (the page is ~1.7k lines and not worth mounting; the pieces
 * it composes have their own RTL tests). The three things that must not drift:
 *  1. ONE "Restrict…" menu sits beside Limit in portal… in the bulk bar, and every existing bulk button is still there;
 *  2. "Select all matching" fetches with the SAME filters the list shows (one shared object, no copy to drift);
 *  3. the REG-B154 reset key covers every input the list query depends on.
 */
const src = fs.readFileSync(path.join(__dirname, "..", "page.tsx"), "utf8");

describe("products/page.tsx - row 509 wiring", () => {
  it("renders the Restrict… menu right after the Limit in portal… buttons", () => {
    expect(src).toMatch(/<PortalLimitButtons[^>]*\/>\s*<RestrictMenu\b/);
  });

  it("keeps every existing bulk control", () => {
    for (const needle of [
      "Group as variants of…",
      "Assign to type…",
      "<PortalBulkButtons",
      "<PortalLimitButtons",
      "Deselect all",
      'data-testid="bulk-destructive"',
      "<ProductsExportButton",
      "<NewFamilyButton",
    ])
      expect(src).toContain(needle);
  });

  it("the list query and select-all-matching share one filters object", () => {
    expect(src).toMatch(/const listFilters = \{/);
    expect(src).toMatch(/useProducts\(\{\s*\.\.\.listFilters,/);
    expect(src).toMatch(/<SelectAllMatching[\s\S]{0,400}?filters=\{listFilters\}/);
  });

  it("select-all-matching resets with the same inputs as the REG-B154 selection reset", () => {
    const m = /<SelectAllMatching[\s\S]{0,600}?resetKey=\{([^}]*)\}/.exec(src);
    expect(m).not.toBeNull();
    for (const k of [
      "page",
      "debouncedSearch",
      "categoryFilter",
      "stockFilter",
      "sectionFilter",
      "pageSize",
      "hiddenOnly",
    ])
      expect(m![1]).toContain(k);
  });
});
