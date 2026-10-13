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

  it("never builds the 404ing /finance/vendor-bills/ path", () => {
    expect(page).not.toContain("/finance/vendor-bills/");
  });

  it("links both the expense row and the expense detail to /vendor-bills/<id>", () => {
    expect(page).toContain("href={`/vendor-bills/${e.vendorBillId}`}");
    expect(page).toContain("href={`/vendor-bills/${expense.vendorBillId}`}");
  });
});
