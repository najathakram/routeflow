/**
 * K11-19 (lane L2): Add a unit and Reset all to Auto on one row, 8px apart, 12px below the Change prices panel.
 *
 * NOT RUN: written without a browser (Jest + RTL pins the classes and the compiled variants in
 * `units-v2/structure/UnitStructure.k11-19.test.tsx`). This spec carries the pixel claims and must be run on the local
 * compose stack (`npm run local:up` + `local:seed`, then `npm run local:e2e`), flag `flag.units_prices_v2` ON.
 *
 * READ-ONLY: it opens panels but never submits them. A tenant not served the flag FAILS the spec (never a skip), and the
 * fixture product E2E-FIX-UNITS must offer both openers (a unit with a price to reset).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { VIEWPORTS, productBySku, requireUnitsV2Flag } from "./helpers/units-v2-support";

/** The base URL comes from the environment only. Unset is an error, never a default site. */
function baseUrl(): string {
  const url = process.env.PLAYWRIGHT_BASE_URL;
  if (!url) throw new Error("PLAYWRIGHT_BASE_URL is not set: point this spec at the local stack.");
  return url;
}

const SKU = "E2E-FIX-UNITS";
const ID = {
  add: "units-v2-add-open",
  reset: "units-v2-reset-open",
  addPanel: "units-v2-add-panel",
  resetPanel: "units-v2-reset-panel",
  change: "units-v2-btn-change-open",
  changePanel: "units-v2-change-panel",
  grid: "units-v2-grid",
  row: "units-v2-structure-row",
};

async function openProduct(page: Page, context: Parameters<typeof setTenantCookie>[0]) {
  await setTenantCookie(context, baseUrl());
  const ctx = await requireUnitsV2Flag(page);
  const product = await productBySku(page, ctx, SKU);
  await page.goto(`/products/${product.id}`);
  await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });
}

const box = async (loc: Locator) => {
  const b = await loc.boundingBox();
  expect(b, "has a box").toBeTruthy();
  return b!;
};

for (const vp of VIEWPORTS) {
  test.describe(`K11-19 opener row @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("the two openers share a row (or wrap with the same 8px gap), edge-aligned with the grid card", async ({
      page,
      context,
    }) => {
      await openProduct(page, context);
      const add = await box(page.getByTestId(ID.add));
      const reset = await box(page.getByTestId(ID.reset));
      const card = await box(page.getByTestId(ID.grid));

      const sameRow = Math.abs(add.y - reset.y) <= 1;
      if (sameRow) {
        // Equal tops and 8px between them.
        expect(reset.x - (add.x + add.width), "8px between the openers").toBeGreaterThanOrEqual(7);
        expect(reset.x - (add.x + add.width), "8px between the openers").toBeLessThanOrEqual(9);
      } else {
        // Wrapped: the same 8px gap, vertically, and both start at the same left edge.
        expect(Math.abs(add.x - reset.x), "wrapped openers share a left edge").toBeLessThanOrEqual(
          1,
        );
        const gap = reset.y - (add.y + add.height);
        expect(gap, "8px between the wrapped openers").toBeGreaterThanOrEqual(7);
        expect(gap, "8px between the wrapped openers").toBeLessThanOrEqual(9);
      }
      // 1440 and 768 are wide enough for one row; at 390 the two fit one row (~250px) or wrap the same way.
      if (vp.width >= 768) expect(sameRow, "one row at this width").toBe(true);

      // The row's left edge is the grid card's outer edge (+-1px), not inset by a frame padding.
      expect(Math.abs(add.x - card.x), "edge-aligned with the grid card").toBeLessThanOrEqual(1);
    });

    test("with Change prices open, the openers sit at least 12px below that panel", async ({
      page,
      context,
    }) => {
      await openProduct(page, context);
      await page.getByTestId(ID.change).click();
      const panel = await box(page.getByTestId(ID.changePanel));
      const add = await box(page.getByTestId(ID.add));
      const gap = add.y - (panel.y + panel.height);
      expect(gap, "Add a unit is clear of the panel above it").toBeGreaterThanOrEqual(11);
    });

    test("an opened panel takes the full row under the openers", async ({ page, context }) => {
      await openProduct(page, context);
      const rowBox = await box(page.getByTestId(ID.row));
      await page.getByTestId(ID.add).click();
      const panel = page.getByTestId(ID.addPanel);
      await expect(panel).toBeVisible();
      const p = await box(panel);
      // Full width of the row, and on or below the row's top (the opener is hidden while its panel is open).
      expect(Math.abs(p.x - rowBox.x), "panel starts at the row's edge").toBeLessThanOrEqual(1);
      expect(Math.abs(p.width - rowBox.width), "panel fills the row").toBeLessThanOrEqual(1);
      // Reset's opener is still on the row above the panel.
      const reset = await box(page.getByTestId(ID.reset));
      expect(reset.y + reset.height, "Reset sits above the open panel").toBeLessThanOrEqual(
        p.y + 1,
      );
    });

    test("with both panels open they stack in the order they were opened", async ({
      page,
      context,
    }) => {
      await openProduct(page, context);
      await page.getByTestId(ID.reset).click();
      await expect(page.getByTestId(ID.resetPanel)).toBeVisible();
      await page.getByTestId(ID.add).click();
      await expect(page.getByTestId(ID.addPanel)).toBeVisible();
      const reset = await box(page.getByTestId(ID.resetPanel));
      const add = await box(page.getByTestId(ID.addPanel));
      expect(add.y, "Add was opened second, so it sits below Reset").toBeGreaterThan(
        reset.y + reset.height - 1,
      );
    });
  });
}
