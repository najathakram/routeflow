/**
 * K11-15 (lane L2, price editing): after Change prices Apply the bar says what is staged and focus goes to Save.
 * NOT RUN in the authoring session (no browser there): the Jest proof is
 * units-v2/change-prices/ApplySaysStaged.test.tsx. Run on the local compose lane, project `units-v2`, at 1440 / 768 / 390.
 *
 * Role OPERATOR on the approved test tenant; fixture product E2E-FIX-CASEDEFAULT. Nothing is saved: the draft is
 * discarded at the end, so the fixture is untouched.
 */
import { test, expect } from "@playwright/test";
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
const visible = (page: import("@playwright/test").Page, testId: string) =>
  page.locator(`[data-testid="${testId}"]:visible`);

for (const vp of VIEWPORTS) {
  test.describe(`K11-15 Apply says what is staged @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("the sentence is visible on one or two lines and Save has focus", async ({
      page,
      context,
    }) => {
      await setTenantCookie(context, baseUrl());
      const ctx = await requireUnitsV2Flag(page);
      const product = await productBySku(page, ctx, SKU);
      await page.goto(`/products/${product.id}`);
      await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });

      await visible(page, ID.btnChange).click();
      await page.getByLabel("Unit").selectOption({ index: 0 });
      await page.getByLabel("Amount").fill("5");
      await page.getByRole("button", { name: "Apply" }).click();

      const text = page.getByTestId(ID.ebText);
      await expect(text).toContainText(/raised 5%: \d+ prices? ready\. Save to keep (it|them)\./);
      await expect(text).toBeInViewport();
      const box = await text.boundingBox();
      const lineHeight = await text.evaluate((el) =>
        Number(getComputedStyle(el).lineHeight.replace("px", "")),
      );
      expect(box!.height, "the bar text wraps to at most two lines").toBeLessThanOrEqual(
        lineHeight * 2 + 8,
      );
      await expect(page.locator(`#${ID.ebSave}`)).toBeFocused();

      // leave the fixture alone
      await page.getByTestId("units-v2-eb-cancel").click();
      await page.getByTestId("units-v2-eb-discard").click();
    });
  });
}
