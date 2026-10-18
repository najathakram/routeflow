/**
 * K11-24 (F23, F25, P22): the family page's variants table reads like a product list.
 *   Price prints as money ("$1.25"), the Name links to the variant's page, and below sm the read-only table
 *   shows # / Name / Price only and fits the screen (no sideways swipe). From sm up every column shows.
 *
 * LOCAL LANE ONLY (project `k11-l3`). READ-ONLY. The family is discovered (or self-provisioned on the approved
 * test tenant) over the API, like units-v2-family.
 */
import { test, expect } from "@playwright/test";
import { VIEWPORTS, ensureFamily, shot } from "./k11-l3-support";
import { setTenantCookie } from "./helpers/auth";
import { requireUnitsV2Flag } from "./helpers/units-v2-support";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";

for (const vp of VIEWPORTS) {
  test.describe(`K11-24 family variants table @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("k11-l3 read-only variants: money, linked names, fits at 390", async ({
      page,
      context,
    }, info) => {
      await setTenantCookie(context, BASE);
      const ctx = await requireUnitsV2Flag(page);
      const family = await ensureFamily(page, ctx);
      await page.goto(`/products/${family.id}`);
      const table = page.locator("table", {
        has: page.getByRole("columnheader", { name: "Name", exact: true }),
      });
      await expect(table.first()).toBeVisible({ timeout: 20_000 });

      // Every price cell is money, and a variant name goes to its own page.
      const prices = await table.first().locator("tbody tr td span.tabular-nums").allTextContents();
      expect(prices.length).toBeGreaterThan(0);
      for (const t of prices) expect(t.trim()).toMatch(/^(\$\d{1,3}(,\d{3})*\.\d{2}|—)$/);
      const link = table.first().locator("tbody tr").first().getByRole("link").first();
      await expect(link).toHaveAttribute("href", /\/products\/[0-9a-f-]+$/);

      if (vp.width < 640) {
        const wrap = table.first().locator("xpath=..");
        const fits = await wrap.evaluate((el) => el.scrollWidth <= el.clientWidth);
        expect(fits, "the table fits without a sideways swipe").toBe(true);
        await expect(table.first().getByRole("columnheader", { name: "Price" })).toBeVisible();
        for (const h of ["SKU", "Barcode", "Unit code", "Cost"]) {
          await expect(table.first().getByRole("columnheader", { name: h })).toBeHidden();
        }
      } else {
        for (const h of ["Name", "SKU", "Barcode", "Unit code", "Price", "Cost"]) {
          await expect(table.first().getByRole("columnheader", { name: h })).toBeVisible();
        }
      }
      await shot(page, info, "k11-24-family-variants");
    });
  });
}
