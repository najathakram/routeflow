/**
 * K11-10 (UNRUN: written on a machine with no browser or compose stack; run it on the local lane before relying on it).
 * All five tiers fit in the Prices by unit table at 1440 and 768, in read and in edit mode, OR the grid says what is
 * clipped: a "Scroll for {tiers}" line that names the tiers actually cut off. At 390 the phone cards are unchanged.
 *
 * LOCAL LANE ONLY (project `units-v2`). Nothing is saved: Cancel drops the (empty) draft.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { k11BaseUrl } from "./helpers/k11-l2-a-base";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const SKU = "E2E-FIX-CASEDEFAULT";

/** The tier header texts whose right edge is past the scroll region's right edge, and whether the region overflows. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[data-testid="units-v2-units-table"]')!;
    const edge = region.getBoundingClientRect().right;
    const clipped = [...region.querySelectorAll<HTMLElement>("th[data-tier-head]")]
      .filter((th) => th.getBoundingClientRect().right > edge + 0.5)
      .map((th) => th.textContent?.trim() ?? "");
    // Each Contains cell (the table cell with a 7rem minimum) is at most two text lines tall.
    const containsLines = Math.max(
      0,
      ...[...region.querySelectorAll<HTMLElement>('tbody td[class*="min-w-[7rem]"]')].map(
        (td) => td.children.length,
      ),
    );
    return { fits: region.scrollWidth <= region.clientWidth, clipped, containsLines };
  });
}

async function expectFitsOrCue(page: Page) {
  const m = await measure(page);
  if (m.fits && m.clipped.length === 0) return;
  const cue = page.getByTestId("units-v2-scroll-cue");
  await expect(cue, "overflowing: the cue must be visible").toBeVisible();
  for (const name of m.clipped) {
    await expect(cue, `the cue names the clipped tier ${name}`).toContainText(name);
  }
}

for (const vp of VIEWPORTS) {
  test.describe(`K11-10 five tiers fit or say what is clipped @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("read mode, then edit mode", async ({ page, context }, info) => {
      await setTenantCookie(context, k11BaseUrl());
      const ctx = await requireUnitsV2Flag(page);
      const product = await productBySku(page, ctx, SKU);
      await page.goto(`/products/${product.id}`);
      await expect(page.getByTestId("units-v2-grid")).toBeVisible({ timeout: 20_000 });

      if (vp.cards) {
        // Phone: one card per unit with all five tiers, no table, no cue.
        await expect(page.getByTestId("units-v2-units-table")).toBeHidden();
        await expect(page.getByTestId("units-v2-scroll-cue")).toHaveCount(0);
        const card = page.locator('[data-testid^="units-v2-card-"]:visible').first();
        await expect(card.locator("dt")).toHaveCount(5);
        await shot(page, info, "k11-10-cards");
        return;
      }

      await expectFitsOrCue(page);
      await shot(page, info, "k11-10-read");

      await page.getByTestId("units-v2-btn-edit").click();
      await expect(page.getByTestId("units-v2-editbar")).toBeVisible();
      await expectFitsOrCue(page);
      await shot(page, info, "k11-10-edit");

      // The barcode is the Unit cell's second line, once per row, and there is no Barcode column.
      await expect(page.getByRole("columnheader", { name: "Barcode" })).toHaveCount(0);
      const codes = page.locator(
        '[data-testid^="units-v2-row-"]:visible [data-testid^="units-v2-code-"]',
      );
      expect(await codes.count()).toBeGreaterThan(0);

      // Each Contains cell is at most two lines.
      const m = await measure(page);
      expect(m.containsLines).toBeLessThanOrEqual(2);

      // Scrolled to the end, nothing is clipped, so the cue is gone.
      await page.evaluate(() => {
        const r = document.querySelector<HTMLElement>('[data-testid="units-v2-units-table"]')!;
        r.scrollLeft = r.scrollWidth;
      });
      await expect(page.getByTestId("units-v2-scroll-cue")).toHaveCount(0);
      await page.getByTestId("units-v2-eb-cancel").click();
    });
  });
}
