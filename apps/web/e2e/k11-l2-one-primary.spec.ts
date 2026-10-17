/**
 * K11-18 (lane L2, price editing): one Cancel and one primary while Change prices is open.
 * NOT RUN in the authoring session (no browser there): the Jest proof is
 * units-v2/change-prices/OneCancelOnePrimary.test.tsx. Run on the local compose lane, project `units-v2`, at 1440 / 768 / 390.
 *
 * Role OPERATOR on the approved test tenant; fixture product E2E-FIX-CASEDEFAULT. The draft is discarded at the end, so
 * the fixture is untouched.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { VIEWPORTS, productBySku, requireUnitsV2Flag } from "./helpers/units-v2-support";
import { UNITS_V2_IDS as ID } from "./helpers/units-v2-ids";

/** The base URL comes from the environment and is never defaulted: an unset one must stop the run, not hit a real site. */
function baseUrl(): string {
  const url = process.env.PLAYWRIGHT_BASE_URL;
  if (!url) throw new Error("PLAYWRIGHT_BASE_URL is not set; point it at the local stack.");
  return url;
}

const SKU = "E2E-FIX-CASEDEFAULT";
const visible = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]:visible`);

for (const vp of VIEWPORTS) {
  test.describe(`K11-18 one primary while Change prices is open @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("the bar steps aside, the bar height holds, and the buttons come back", async ({
      page,
      context,
    }) => {
      await setTenantCookie(context, baseUrl());
      const ctx = await requireUnitsV2Flag(page);
      const product = await productBySku(page, ctx, SKU);
      await page.goto(`/products/${product.id}`);
      await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });

      await visible(page, ID.btnEdit).click();
      const bar = page.getByTestId(ID.editbar);
      await expect(bar).toBeVisible();
      const before = await bar.boundingBox();

      await visible(page, ID.btnChange).click();
      await expect(page.getByRole("button", { name: "Finish Change prices first." })).toBeVisible();
      await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(1);
      await expect(page.locator(`#${ID.ebSave}`)).toHaveCount(0);
      const open = await bar.boundingBox();
      expect(Math.abs(open!.height - before!.height), "the bar does not jump").toBeLessThanOrEqual(
        1,
      );

      await page.getByRole("button", { name: "Finish Change prices first." }).click();
      await expect(page.locator("#change-panel")).toBeFocused();

      await page.locator("#ch-cancel").click();
      await expect(page.locator(`#${ID.ebSave}`)).toBeVisible();
      await expect(page.getByTestId("units-v2-eb-cancel")).toBeVisible();

      // leave the fixture alone
      await page.getByTestId("units-v2-eb-cancel").click();
      await page.getByTestId("units-v2-eb-discard").click();
    });
  });
}
