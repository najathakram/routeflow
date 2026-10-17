/**
 * K11-23 (prior F28): prices on the first phone screen, at 1440 / 768 / 390.
 *   390 and 768: after load, the "Price per ..." label's top is inside the first screen; the Tab order follows
 *   what is on screen (tops never go backwards); Buyer merchandising ends the Details card.
 *   1440: two columns, the Image card on the left, Details on the right, both starting on the same line.
 *
 * LOCAL LANE ONLY (project `units-v2`). READ-ONLY. Role: OPERATOR (staff, so merchandising is visible) on the
 * approved test tenant; fixture E2E-FIX-UNITS with no photos. Run once with `flag.units_prices_v2` on (the jump
 * strip is present); a tenant without the flag fails the spec, as in the rest of the lane.
 */
import { test, expect } from "@playwright/test";
import { VIEWPORTS, openFixtureProduct, shot, viewportHeight } from "./k11-l3-support";

for (const vp of VIEWPORTS) {
  test.describe(`K11-23 prices first @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("k11-l3 price label above the fold, tab order matches the screen, two columns at 1440", async ({
      page,
      context,
    }, info) => {
      await openFixtureProduct(page, context);
      const label = page.getByText(/^Price per /).first();
      await expect(label).toBeVisible();
      const details = page
        .locator("div.overflow-hidden", {
          has: page.getByRole("heading", { name: "Details", exact: true }),
        })
        .first();
      const image = page
        .locator("div.overflow-hidden", {
          has: page.getByRole("heading", { name: "Image", exact: true }),
        })
        .first();
      const d = (await details.boundingBox())!;
      const i = (await image.boundingBox())!;

      if (vp.width >= 1024) {
        expect(i.x + i.width, "Image is the left column").toBeLessThanOrEqual(d.x + 1);
        expect(Math.abs(i.y - d.y), "both columns start on one line").toBeLessThanOrEqual(1);
      } else {
        const top = (await label.boundingBox())!.y;
        expect(top, "the price label is on the first screen").toBeLessThan(viewportHeight(page));
        expect(d.y, "Details comes before Image").toBeLessThan(i.y);

        // Tab through the first controls: each one is at or below the previous (reading order = tab order).
        await page.locator("h1#h-product").focus();
        let last = -1;
        for (let n = 0; n < 12; n++) {
          await page.keyboard.press("Tab");
          const y = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            return el ? el.getBoundingClientRect().top + window.scrollY : -1;
          });
          expect(y, `Tab stop ${n + 1} does not jump back up the page`).toBeGreaterThanOrEqual(
            last - 2,
          );
          last = Math.max(last, y);
        }
      }

      // Buyer merchandising ends the Details card at every width.
      const merch = details.getByRole("heading", { name: "Buyer merchandising" });
      await expect(merch).toBeVisible();
      const m = (await merch.boundingBox())!;
      const desc = (await details.getByText("Description", { exact: true }).boundingBox())!;
      expect(m.y, "merchandising comes after Description").toBeGreaterThan(desc.y);
      await shot(page, info, "k11-23-prices-first");
    });
  });
}
