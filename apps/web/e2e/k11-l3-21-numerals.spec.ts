/**
 * K11-21 (P04): one numeral style in Details. Every money figure in the product page's Details card is
 * `$1,234.00` text in tabular figures, at 1440 / 768 / 390.
 *
 * LOCAL LANE ONLY (project `k11-l3`). READ-ONLY. Role: OPERATOR on the approved test tenant; fixture E2E-FIX-UNITS.
 */
import { test, expect } from "@playwright/test";
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
      const figures = await card.evaluate((root) =>
        Array.from(root.querySelectorAll<HTMLElement>("*"))
          .filter((el) => el.children.length === 0 && /\$\s*\d/.test(el.textContent ?? ""))
          .map((el) => ({
            text: (el.textContent ?? "").trim(),
            tabular: getComputedStyle(el).fontVariantNumeric.includes("tabular-nums"),
          })),
      );
      expect(figures.length, "Details shows at least the price and the tiers").toBeGreaterThan(0);
      for (const f of figures) {
        expect(f.text, `"${f.text}" is formatMoney text`).toMatch(/^\$\d{1,3}(,\d{3})*\.\d{2}$/);
        expect(f.tabular, `"${f.text}" is set in tabular figures`).toBe(true);
      }
      await shot(page, info, "k11-21-details-numerals");
    });
  });
}
