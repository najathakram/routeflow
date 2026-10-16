/**
 * Units v2 (units-v2-grid): the product page's unit ladder grid.
 *   open a product with a boxed unit ladder -> the grid shows -> the code column is headed "Barcode" (never "SKU")
 *   -> every price cell reads "Auto" or "Set" -> at 390 the ladder is cards, at 768 / 1440 it is the table.
 *
 * LOCAL LANE ONLY (project `units-v2`, registered by playwright.config.ts only for a local base URL outside GitHub Actions).
 * Read-only: the spec creates and changes nothing. Role: OPERATOR on an approved test tenant. The boxed-ladder product is the
 * seeded fixture E2E-FIX-UNITS (apps/api/scripts/e2e-seed.js). A tenant not served `flag.units_prices_v2` FAILS the spec.
 */
import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { UNITS_V2_IDS, UNITS_V2_PREFIX } from "./helpers/units-v2-ids";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const BOXED_SKU = "E2E-FIX-UNITS";

for (const vp of VIEWPORTS) {
  test.describe(`Units v2 grid @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("boxed ladder: Barcode header, Auto/Set cells, cards on phone, table otherwise", async ({
      page,
      context,
    }, info) => {
      await setTenantCookie(context, BASE);
      const ctx = await requireUnitsV2Flag(page);
      const product = await productBySku(page, ctx, BOXED_SKU);

      await page.goto(`/products/${product.id}`);
      const grid = page.getByTestId(UNITS_V2_IDS.grid);
      await expect(grid).toBeVisible({ timeout: 20_000 });

      await expect(grid.getByText("Barcode", { exact: true }).first()).toBeVisible();
      await expect(grid.getByText("SKU", { exact: true })).toHaveCount(0);

      const cells = grid.locator(`[data-testid^="${UNITS_V2_PREFIX.cell}"]:visible`);
      const n = await cells.count();
      expect(n, "the boxed ladder shows at least one price cell").toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        await expect(cells.nth(i)).toHaveText(/\b(Auto|Set)\b/);
      }

      const cards = page.locator(`[data-testid^="${UNITS_V2_PREFIX.card}"]:visible`);
      const rows = page.locator(`[data-testid^="${UNITS_V2_PREFIX.row}"]:visible`);
      if (vp.cards) {
        expect(await cards.count(), "phone width renders the ladder as cards").toBeGreaterThan(0);
        await expect(rows).toHaveCount(0);
      } else {
        expect(await rows.count(), `${vp.name}px renders the ladder as the table`).toBeGreaterThan(
          0,
        );
        await expect(cards).toHaveCount(0);
      }
      await shot(page, info, "grid");
    });
  });
}
