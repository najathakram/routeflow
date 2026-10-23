/**
 * K11-11 (UNRUN: written on a machine with no browser or compose stack; run it on the local lane before relying on it).
 * A unit that does not exist yet shows no price: on a product with no 1-piece unit the Piece row reads as dashes with
 * one "Add Piece unit" button, and that button opens Add a unit as the Piece and never closes it when it is already open.
 *
 * LOCAL LANE ONLY (project `units-v2`). Read-only: nothing is written. Fixture product E2E-FIX-CASEDEFAULT has no
 * 1-piece unit (apps/api/scripts/e2e-seed.js ensureUnitsFixture).
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { k11BaseUrl } from "./helpers/k11-l2-a-base";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const SKU = "E2E-FIX-CASEDEFAULT";
const visible = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]:visible`);

for (const vp of VIEWPORTS) {
  test.describe(`K11-11 phantom Piece row @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("the Piece row is dashes with one Add Piece unit button; the button opens the panel and never shuts it", async ({
      page,
      context,
    }, info) => {
      await setTenantCookie(context, k11BaseUrl());
      const ctx = await requireUnitsV2Flag(page);
      const product = await productBySku(page, ctx, SKU);
      await page.goto(`/products/${product.id}`);
      await expect(page.getByTestId("units-v2-grid")).toBeVisible({ timeout: 20_000 });

      const row = vp.cards
        ? page.locator('[data-testid^="units-v2-card-"]:visible', { hasText: "Add Piece unit" })
        : page.locator('[data-testid^="units-v2-row-"]:visible', { hasText: "Add Piece unit" });
      await expect(row).toHaveCount(1);
      await expect(row).not.toContainText("$");
      await expect(row).not.toContainText(/\b(Auto|Set)\b/);
      await shot(page, info, "k11-11-phantom-row");

      const button = row.getByRole("button", { name: "Add Piece unit" });
      await button.click();
      await expect(page.getByTestId("units-v2-add-panel")).toBeVisible();
      await expect(page.getByTestId("units-v2-add-n")).toHaveValue("1");

      // Already open: the button leaves the panel open and puts focus in it.
      await button.click();
      await expect(page.getByTestId("units-v2-add-panel")).toBeVisible();
      await expect(page.getByTestId("units-v2-add-name")).toBeFocused();
    });
  });
}
