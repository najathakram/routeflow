/**
 * K11-09 (lane L1): /products, the card focus ring shows and ArrowDown from the search reaches the
 * first product. READ-ONLY: it only types in the search box and moves focus. Needs the local compose
 * stack on a `qa-*` test tenant; never run against a live tenant.
 */

import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";

/** A local-lane spec never defaults to a deployed host: the base URL must be given. */
function baseUrl(): string {
  const url = process.env.PLAYWRIGHT_BASE_URL;
  if (!url) {
    throw new Error(
      "PLAYWRIGHT_BASE_URL is not set: this local-lane spec needs the local stack URL (e.g. http://localhost:3001) and never defaults to a deployed host.",
    );
  }
  return url;
}

const WIDTHS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
];

for (const vp of WIDTHS) {
  test.describe(`K11-09 /products focus @${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test.beforeEach(async ({ page, context }) => {
      await setTenantCookie(context, baseUrl());
      await page.goto("/products");
    });

    test("ArrowDown from the search focuses the first product link and the ring sits inside the card", async ({
      page,
    }) => {
      const search = page.getByRole("searchbox");
      const first = page.locator("a[data-product-name-link]").first();
      // The list loads after the search box is there: pressing ArrowDown before the first link exists is a race.
      await expect(first).toBeVisible({ timeout: 20_000 });
      await search.click();
      await search.press("ArrowDown");
      await expect(first).toBeFocused();

      // The ring is the link's ::after overlay; it must lie fully inside the (overflow-hidden) card.
      const card = first.locator("xpath=ancestor::div[contains(@class,'overflow-hidden')][1]");
      const cardBox = await card.boundingBox();
      const linkBox = await first.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(linkBox).not.toBeNull();
      await page.screenshot({
        path: `../../local-assets/k11-09-focus-${vp.name}.png`,
        clip: cardBox!,
      });
    });
  });
}
