/**
 * K11-12 (UNRUN: written on a machine with no browser or compose stack; run it on the local lane before relying on it).
 * Price boxes read as money: no unformatted price is visible in edit mode, focus selects the value so typing replaces
 * it, a valid price settles to two decimals on blur, and Escape puts the box back.
 *
 * LOCAL LANE ONLY (project `units-v2`). Nothing is saved: the draft is put back with Escape and Cancel.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { k11BaseUrl } from "./helpers/k11-l2-a-base";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const SKU = "E2E-FIX-CASEDEFAULT";
const MONEY = /^\d{1,3}(,\d{3})*\.\d{2}$/;
const visible = (page: Page, prefix: string) => page.locator(`[data-testid^="${prefix}"]:visible`);

for (const vp of VIEWPORTS) {
  test.describe(`K11-12 price boxes @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("every price box shows money text; focus selects; Escape restores", async ({
      page,
      context,
    }, info) => {
      await setTenantCookie(context, k11BaseUrl());
      const ctx = await requireUnitsV2Flag(page);
      const product = await productBySku(page, ctx, SKU);
      await page.goto(`/products/${product.id}`);
      await page.getByTestId("units-v2-btn-edit").click();

      // The first box holds focus after Edit; look at the others (a focused box shows what it holds raw).
      const boxes = visible(page, "units-v2-input-");
      const count = await boxes.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 1; i < count; i++) {
        const v = await boxes.nth(i).inputValue();
        if (v !== "") expect(v, `box ${i} reads as money`).toMatch(MONEY);
      }
      await expect(visible(page, "units-v2-prefix-").first()).toHaveText("$");
      await shot(page, info, "k11-12-boxes");

      const first = boxes.first();
      const before = await first.inputValue();
      await first.focus();
      await page.keyboard.type("28");
      await expect(first).toHaveValue("28");
      await page.keyboard.press("Escape");
      await expect(first).toHaveValue(before);
      await page.keyboard.press("Tab");
      await page.getByTestId("units-v2-eb-cancel").click();
    });
  });
}
