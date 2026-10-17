/**
 * K11-13 (UNRUN: written on a machine with no browser or compose stack; run it on the local lane before relying on it).
 * Enter on a price opens that price, and the opened box ends up fully above the save bar. Also: the Edit button's first
 * box is never left half under the bar (the F22 remnant at 1440 and 390).
 *
 * LOCAL LANE ONLY (project `units-v2`). Nothing is saved: Cancel drops the (empty) draft.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { k11BaseUrl } from "./helpers/k11-l2-a-base";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const SKU = "E2E-FIX-CASEDEFAULT";

async function open(page: Page, context: Parameters<typeof setTenantCookie>[0]) {
  await setTenantCookie(context, k11BaseUrl());
  const ctx = await requireUnitsV2Flag(page);
  const product = await productBySku(page, ctx, SKU);
  await page.goto(`/products/${product.id}`);
  await expect(page.getByTestId("units-v2-grid")).toBeVisible({ timeout: 20_000 });
}

/** Whether the focused element sits fully above the top of the save bar. */
async function clearOfBar(page: Page) {
  return page.evaluate(() => {
    const box = document.activeElement?.getBoundingClientRect();
    const bar = document.querySelector('[data-testid="units-v2-editbar"]')?.getBoundingClientRect();
    return box != null && bar != null && box.bottom <= bar.top + 1;
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`K11-13 Enter opens that price @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("Enter on the last visible Tier 4 price focuses that box, above the bar", async ({
      page,
      context,
    }, info) => {
      await open(page, context);
      const buttons = page.locator('button[aria-label^="Edit Tier 4"]:visible');
      const last = buttons.last();
      const label = await last.getAttribute("aria-label");
      await last.focus();
      await page.keyboard.press("Enter");

      const active = page.locator(":focus");
      await expect(active).toHaveAttribute("data-testid", /^units-v2-input-.*-4$/);
      expect(label).toMatch(/^Edit Tier 4 /);
      await expect.poll(() => clearOfBar(page), { timeout: 3000 }).toBe(true);
      await shot(page, info, "k11-13-enter-last-row");
      await page.getByTestId("units-v2-eb-cancel").click();
    });

    test("the Edit button's first box is fully above the bar", async ({ page, context }, info) => {
      await open(page, context);
      await page.getByTestId("units-v2-btn-edit").click();
      await expect(page.locator(":focus")).toHaveAttribute("data-testid", /^units-v2-input-/);
      await expect.poll(() => clearOfBar(page), { timeout: 3000 }).toBe(true);
      await shot(page, info, "k11-13-edit-first-box");
      await page.getByTestId("units-v2-eb-cancel").click();
    });
  });
}
