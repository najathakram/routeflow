/**
 * Settings search speaks the user's words (13): on the /settings hub, "carrier" finds the carrier
 * answer, "low stock" finds the Low-stock digest and opens the notifications tab, and clearing the
 * box brings the grouped hub back. At 1440 and 390 px; the page never scrolls sideways.
 * PR1: at 1440 the groups live in a "Settings" rail that stays beside the open section (the open row is
 * aria-current); at 390 there is no rail, the list is the hub.
 *
 * Role: admin (the pre-authed operator state). READ-ONLY: nothing is saved.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const;

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const vp of VIEWPORTS) {
  test.describe(`Settings search @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("'carrier' shows the answer; 'low stock' opens notifications; clear restores the hub", async ({
      page,
      context,
    }) => {
      await setTenantCookie(context, BASE);
      await page.goto("/settings");
      const search = page.getByLabel("Search settings");
      await expect(search).toBeVisible({ timeout: 15_000 });
      const results = page.getByRole("list", { name: "Search results" });
      const rail = page.getByRole("navigation", { name: "Settings" });
      if (vp.width >= 1280) await expect(rail).toBeVisible();
      else await expect(rail).toHaveCount(0);

      await search.fill("carrier");
      await expect(results.getByText(/choose the carrier on each order/i)).toBeVisible();
      await noHorizontalScroll(page);

      await search.fill("low stock");
      const digest = results.getByRole("link", { name: /Low-stock digest/ });
      await expect(digest).toBeVisible();
      await noHorizontalScroll(page);
      await digest.click();
      await expect(page).toHaveURL(/tab=notifications/);
      // the deep link LANDS on its card, not just the tab (the hash scroll runs on tab screens too)
      await expect(page).toHaveURL(/#low-stock-digest$/);
      await expect(page.locator("#low-stock-digest")).toBeInViewport({ timeout: 10_000 });
      if (vp.width >= 1280) {
        await expect(rail.getByTestId("settings-row-notifications")).toHaveAttribute(
          "aria-current",
          "page",
        );
      }

      // a second deep link, into Business profile: lands on the time zone field
      await page.goto("/settings");
      await page.getByLabel("Search settings").fill("time zone");
      await results.getByRole("link", { name: /Time zone/ }).click();
      await expect(page).toHaveURL(/tab=profile#settings-timezone$/);
      await expect(page.locator("#settings-timezone")).toBeInViewport({ timeout: 10_000 });

      await page.goto("/settings");
      await page.getByLabel("Search settings").fill("zzzzqq");
      await expect(page.getByText("No settings match")).toBeVisible();
      await page.getByRole("button", { name: "Clear Search" }).click();
      await expect(page.getByLabel("Search settings")).toHaveValue("");
      await expect(page.getByTestId("settings-group-business")).toBeVisible();
    });
  });
}
