/**
 * K11-17 (lane L2, price editing): a Raise preview that shows a lower price says why on that row.
 * NOT RUN in the authoring session (no browser there): the Jest proof is
 * units-v2/change-prices/AgainstReason.real.test.tsx (+ against-reason.test.ts, and explainMove in pricing.spec.ts).
 * Run on the local compose lane, project `units-v2`, at 1440 / 768 / 390.
 *
 * Role OPERATOR on the approved test tenant; fixture product E2E-FIX-CASEDEFAULT (a Box of 24, implicit Piece). The K9
 * shape is made in the DRAFT only (a Set Tier 2 on the pack and a Set Retail on the Piece, so the Piece's Auto Tier 2 falls
 * when the pack's Retail rises); nothing is saved and the draft is discarded, so the fixture is untouched.
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
  test.describe(`K11-17 a lower price in a Raise preview says why @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("the reason sits under the row, never beside it", async ({ page, context }) => {
      await setTenantCookie(context, baseUrl());
      const ctx = await requireUnitsV2Flag(page);
      const product = await productBySku(page, ctx, SKU);
      await page.goto(`/products/${product.id}`);
      await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });

      await visible(page, ID.btnEdit).click();
      await visible(page, ID.input("pack", 2)).fill("1000");
      await visible(page, ID.input("base", 1)).fill("5");

      await visible(page, ID.btnChange).click();
      await page.getByLabel("Unit").selectOption({ index: 0 });
      await page.getByLabel("Amount").fill("5");

      const preview = page.getByTestId(ID.changePreview);
      const against = preview.locator('tbody[data-against="true"]');
      await expect(
        against.first(),
        "the Piece's Auto Tier 2 goes down on this Raise",
      ).toBeVisible();
      for (const group of await against.all()) {
        const rows = group.locator("tr");
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(1)).toContainText(/Follows .+, which you set\.|not moving\./);
        const [first, reason] = await Promise.all([
          rows.nth(0).boundingBox(),
          rows.nth(1).boundingBox(),
        ]);
        expect(reason!.y, "the reason starts below the row's figures").toBeGreaterThanOrEqual(
          first!.y + first!.height - 1,
        );
      }

      // leave the fixture alone
      await page.getByRole("button", { name: "Cancel" }).first().click();
      await page.getByTestId("units-v2-eb-cancel").click();
      await page.getByTestId("units-v2-eb-discard").click();
    });
  });
}
