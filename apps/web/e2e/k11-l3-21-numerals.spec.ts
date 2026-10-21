/**
 * K11-21 (P04): one numeral style for product money. Every money figure in the product page's Details card AND in
 * the prices grid is `$1,234.00` text in tabular figures, at 1440 / 768 / 390. Under the v2 grid (R3 say-no 2) the
 * Details card no longer carries the price or the tiers: the grid is their home, so it is read here too, and the
 * grid must show at least the price and the tiers.
 *
 * LOCAL LANE ONLY (project `k11-l3`). READ-ONLY. Role: OPERATOR on the approved test tenant; fixture E2E-FIX-UNITS.
 */
import { test, expect, type Locator } from "@playwright/test";
import { UNITS_V2_IDS } from "./helpers/units-v2-ids";
import { VIEWPORTS, openFixtureProduct, shot } from "./k11-l3-support";

for (const vp of VIEWPORTS) {
  test.describe(`K11-21 Details numerals @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("k11-l3 every Details price is formatMoney text in tabular figures", async ({
      page,
      context,
    }, info) => {
      await openFixtureProduct(page, context);
      const card = page.getByTestId("product-details-card");
      await expect(card).toBeVisible();
      const grid = page.getByTestId(UNITS_V2_IDS.grid);
      await expect(grid).toBeAttached();
      const readFigures = (root: Locator) =>
        root.evaluate((el) =>
          Array.from(el.querySelectorAll<HTMLElement>("*"))
            .filter((n) => n.children.length === 0 && /\$\s*\d/.test(n.textContent ?? ""))
            .map((n) => ({
              text: (n.textContent ?? "").trim(),
              tabular: getComputedStyle(n).fontVariantNumeric.includes("tabular-nums"),
            })),
        );
      const gridFigures = await readFigures(grid);
      expect(
        gridFigures.length,
        "the prices grid shows at least the price and the tiers",
      ).toBeGreaterThan(0);
      // Details keeps MSRP (money when set); the fixture has none, so Details may legitimately have 0 figures.
      const figures = [...(await readFigures(card)), ...gridFigures];
      for (const f of figures) {
        expect(f.text, `"${f.text}" is formatMoney text`).toMatch(/^\$\d{1,3}(,\d{3})*\.\d{2}$/);
        expect(f.tabular, `"${f.text}" is set in tabular figures`).toBe(true);
      }
      await shot(page, info, "k11-21-details-numerals");
    });
  });
}
