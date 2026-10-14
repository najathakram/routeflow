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
    expect(src).toMatch(/<PortalLimitButtons\b[\s\S]{0,200}?\/>\s*<RestrictMenu\b/);
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
  describe("a banner selection holds off-page ids: only Restrict… may act on it", () => {
    it("tracks the banner state and gives every other bulk action the hint", () => {
      // derived from the ids (any selected id the page does not hold) by the one extracted rule
      expect(src).toMatch(
        /useOffPageSelection\(selected,\s*\(id\)\s*=>\s*productById\.has\(id\),?\s*\)/,
      );
      expect(src).toMatch(/<PortalBulkButtons[\s\S]{0,200}?offPageHint=\{offPageHint\}/);
      expect(src).toMatch(/<PortalLimitButtons[\s\S]{0,200}?offPageHint=\{offPageHint\}/);
    });

    it("Group as variants, Assign to type and Delete are disabled while it is on", () => {
      for (const label of ["Group as variants of…", "Assign to type…"]) {
        const m = new RegExp("disabled=\\{([^}]*)\\}[^<]*?>\\s*" + label).exec(src);
        expect(m).not.toBeNull();
        expect(m![1]).toContain("bannerSelected");
      }
      // Delete is the extracted button that owns the disabled rule (behaviour: OffPageSelection.test.tsx)
      expect(src).toMatch(/<BulkDeleteButton[\s\S]{0,300}?offPage=\{bannerSelected\}/);
    });

    it("the delete handler itself refuses banner-selected ids (not just the button)", () => {
      expect(src).toMatch(
        /const handleBulkDelete = async \(\) => \{\s*if \(bannerSelected\) return;/,
      );
    });

    it("RestrictMenu is NOT disabled by it", () => {
      const m = /<RestrictMenu[\s\S]*?\/>/.exec(src);
      expect(m![0]).not.toMatch(/bannerSelected|offPageHint/);
    });
  });
  describe("apple-ux fixes on the selection bars", () => {
    it("Clear selection lives once, in the banner, not again in the action bar", () => {
      expect(src).not.toContain("Clear selection");
    });

    it("Deselect all reads as a link, not as a disabled control", () => {
      const m =
        /<button\s+onClick=\{\(\) => setSelected\(new Set\(\)\)\}\s+className="([^"]*)"\s*>\s*Deselect all/.exec(
          src,
        );
      expect(m).not.toBeNull();
      expect(m![1]).toMatch(/text-brand-600/);
      expect(m![1]).not.toMatch(/text-navy\/70/);
    });
  });
});
