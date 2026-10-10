import * as fs from "fs";
import * as path from "path";

/**
 * B919 — /inventory and /dashboard clipped the tab strip, toolbar, row actions and the Cancelled status
 * cell at 390/768 with no scroll affordance. These pages are far too heavy to render in a unit test, so
 * this pins the layout CLASSES that fix it (a source-structure pin; F prover's Playwright captures at
 * 1440/768/390 are the visual proof). A regression that re-introduces `overflow-hidden` on the table shell
 * or drops the wrapping/scrolling utilities fails here.
 */
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

describe("/inventory overflow (B919)", () => {
  const src = read("./page.tsx");

  it("the tab strip scrolls horizontally and its triggers never shrink or wrap", () => {
    expect(src).toMatch(/<Tabs\.List className="[^"]*\boverflow-x-auto\b[^"]*"/);
    expect(src).toMatch(
      /"shrink-0 whitespace-nowrap[^"]*-mb-px|-mb-px[^"]*shrink-0 whitespace-nowrap/,
    );
  });

  it("the stock toolbar buttons wrap instead of overflowing", () => {
    expect(src).toMatch(/<div className="flex flex-wrap gap-2">[\s\S]{0,2500}?Adjust Stock/);
  });

  it("the stock table shell is a ScrollShadow (scrolls + edge fade), never overflow-hidden", () => {
    expect(src).toMatch(
      /<ScrollShadow className="rounded-b-lg border border-t-0 border-surface-border bg-white shadow-card">/,
    );
    expect(src).toMatch(/<\/ScrollShadow>/);
    expect(src).not.toMatch(/<div className="overflow-hidden rounded-b-lg border border-t-0/);
  });
});

describe("/dashboard overflow (B919)", () => {
  const src = read("../dashboard/page.tsx");

  it("the Recent Orders header wraps and its table shell scrolls", () => {
    expect(src).toMatch(/<div className="mb-4 flex flex-wrap items-center justify-between gap-2">/);
    // the shared Table is ALREADY a ScrollShadow: wrapping it in a second one doubled the fades
    expect(src).toMatch(/<div className="-mx-6 -mb-6">\s*<Table/);
    expect(src).not.toMatch(/<ScrollShadow className="-mx-6 -mb-6">/);
  });
});
