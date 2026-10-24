/**
 * The expenses surface on the supplier-bills page links to the linked bill. The real route is
 * /vendor-bills/[id]; there is no /finance/vendor-bills/[id] route, so that href 404s. The page is
 * a large client component with no RTL harness, so the hrefs are pinned from source.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const DASHBOARD = join(__dirname, "..");
const page = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("linked supplier-bill hrefs", () => {
  it("the real bill route exists and the finance-prefixed one does not", () => {
    expect(existsSync(join(DASHBOARD, "vendor-bills", "[id]", "page.tsx"))).toBe(true);
    expect(existsSync(join(DASHBOARD, "finance", "vendor-bills"))).toBe(false);
  });

  it("never builds the 404ing /finance/vendor-bills path, however it is spelled", () => {
    expect(page).not.toMatch(/["'`]\/finance\/vendor-bills\b/);
  });

  it("every link to a linked bill goes to /vendor-bills/<id> (row icon and detail modal)", () => {
    const hrefs = page.match(/href=\{`[^`]*vendorBillId[^`]*`\}/g) ?? [];
    expect(hrefs).toHaveLength(2);
    for (const h of hrefs)
      expect(h).toMatch(/^href=\{`\/vendor-bills\/\$\{\w+\.vendorBillId\}`\}$/);
  });
});
