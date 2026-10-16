/**
 * Units v2 (units-v2-stock-off): with stock tracking off for the tenant the product header says where stock lives
 * instead of showing a count.
 *   header: "Stock: see Inventory" link, no "in stock" count -> the Stock & cost card has no On hand / waitlist rows
 *   but keeps cost.
 *
 * LOCAL LANE ONLY (project `units-v2`). Read-only; precondition is the test tenant's stock setting being OFF, which the
 * spec asserts through the header it observes (a header that still counts stock FAILS here, it is not skipped).
 * A tenant not served `flag.units_prices_v2` FAILS the spec.
 */
import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { UNITS_V2_IDS } from "./helpers/units-v2-ids";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const SKU = "E2E-FIX-UNITS";

for (const vp of VIEWPORTS) {
  test.describe(`Units v2 stock off @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("header links to Inventory; Stock & cost keeps cost, drops On hand / waitlist", async ({
      page,
      context,
    }, info) => {
      await setTenantCookie(context, BASE);
      const ctx = await requireUnitsV2Flag(page);
      const product = await productBySku(page, ctx, SKU);

      await page.goto(`/products/${product.id}`);
      const link = page.getByTestId(UNITS_V2_IDS.headerStockLink);
      await expect(link).toBeVisible({ timeout: 20_000 });
      await expect(link).toContainText("Stock: see Inventory");
      await expect(page.getByText(/\bin stock\b/i)).toHaveCount(0);

      const card = page
        .locator("section, div")
        .filter({ has: page.getByRole("heading", { name: /Stock\s*&\s*cost/i }) })
        .last();
      await expect(card).toBeVisible();
      await expect(card.getByText(/On hand/i)).toHaveCount(0);
      await expect(card.getByText(/waitlist/i)).toHaveCount(0);
      await expect(card.getByText(/cost/i).first()).toBeVisible();
      await shot(page, info, "stock-off");
    });
  });
}
