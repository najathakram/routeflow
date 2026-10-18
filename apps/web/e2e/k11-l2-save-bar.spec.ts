/**
 * K11-14 (UNRUN: written on a machine with no browser or compose stack; run it on the local lane before relying on it).
 * The save bar lines up with the grid card (edges within 1 px), the key hint is not shown at 390 and the bar's message
 * is one line there, and an Auto box has no visible "Auto" caption.
 *
 * LOCAL LANE ONLY (project `units-v2`). Nothing is saved: Cancel drops the (empty) draft.
 */
import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { k11BaseUrl } from "./helpers/k11-l2-a-base";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const SKU = "E2E-FIX-CASEDEFAULT";

for (const vp of VIEWPORTS) {
  test.describe(`K11-14 save bar and captions @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("bar edges match the grid card; hint only from md; no visible Auto caption", async ({
      page,
      context,
    }, info) => {
      await setTenantCookie(context, k11BaseUrl());
      const ctx = await requireUnitsV2Flag(page);
      const product = await productBySku(page, ctx, SKU);
      await page.goto(`/products/${product.id}`);
      await page.getByTestId("units-v2-btn-edit").click();

      const bar = page.getByTestId("units-v2-editbar");
      await expect(bar).toBeVisible();
      const card = await page.getByTestId("units-v2-grid").boundingBox();
      const b = await bar.boundingBox();
      expect(card).not.toBeNull();
      expect(b).not.toBeNull();
      expect(Math.abs(b!.x - card!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(b!.x + b!.width - (card!.x + card!.width))).toBeLessThanOrEqual(1);

      const hint = page.getByTestId("units-v2-eb-hint");
      if (vp.width < 768) {
        await expect(hint).toBeHidden();
        const text = await page.getByTestId("units-v2-eb-text").boundingBox();
        expect(text!.height, "the bar's message is one line").toBeLessThan(28);
      } else {
        await expect(hint).toBeVisible();
      }

      // Under an Auto box nothing visible says "Auto": its value is the grey placeholder.
      const visibleAuto = await page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLElement>('[data-testid^="units-v2-cell-"] div')].filter(
            (el) => el.textContent?.trim() === "Auto" && el.offsetParent !== null,
          ).length,
      );
      expect(visibleAuto, "no visible Auto caption in edit mode").toBe(0);
      await shot(page, info, "k11-14-bar");
      await page.getByTestId("units-v2-eb-cancel").click();
    });
  });
}
