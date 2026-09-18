/**
 * Deliveries/new ("Plan a delivery") mobile layout — spec 49.
 *
 * Below `lg` (1024px) the page swaps its fixed, no-breakpoint two-column
 * desktop layout for a map-canvas + draggable bottom-sheet layout
 * (owner-requested phone UX, 2026-09-17). Before this work the page had no
 * breakpoints at all: at 390px the map and Compare-routes panel were cut
 * off and the page scrolled sideways.
 *
 * This spec proves, at each of 390/768/1440:
 *   - the page never scrolls horizontally (the bug this batch fixes);
 *   - below `lg` the drag-handle button cycles the sheet through all three
 *     detents (peek → half → full → peek), each still with no horizontal
 *     scroll;
 *   - below `lg` the desktop two-column body is absent, and vice versa at
 *     1440 the classic layout still renders with no bottom sheet.
 *
 * Read-only / assert-visibility-only, same convention as
 * 20-trip-builder-gate.spec.ts: Build/Send are never clicked, and this
 * exercises the PICKING phase only (zero orders selected) — no fixtures are
 * created or mutated. Requires the `order_delivery` addon enabled on the
 * seeded tenant (same precondition as spec 20); self-skips otherwise.
 */
import { test, expect, type Page } from "@playwright/test";
import { apiBase, operatorAccessToken } from "./helpers/api";

async function assertNoHorizontalScroll(page: Page) {
  const [scrollWidth, innerWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

/** Skips the test when auth setup didn't run or the tenant lacks the
 *  order_delivery addon — mirrors 20-trip-builder-gate.spec.ts exactly. */
async function requireOrderDeliveryAddon(page: Page) {
  await page.goto("/orders");
  const token = await operatorAccessToken(page);
  test.skip(!token, "no operator token — auth setup did not run");
  const res = await page.request.get(`${apiBase(page.url())}/api/v1/tenants/me/addons`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { addons = [] } = await res.json();
  test.skip(!addons.includes("order_delivery"), "order_delivery addon not enabled on this tenant");
}

test.describe("deliveries/new — mobile bottom sheet (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("map-canvas layout: no horizontal scroll at any of the three detents", async ({ page }) => {
    await requireOrderDeliveryAddon(page);

    await page.goto("/deliveries/new");
    await expect(page).toHaveURL(/\/deliveries\/new/);
    await assertNoHorizontalScroll(page);

    await expect(page.getByTestId("delivery-mobile-layout")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("delivery-desktop-layout")).toHaveCount(0);

    const handle = page.getByRole("button", { name: /delivery details/i });
    await expect(handle).toBeVisible();

    // Default detent is "half" (owner spec item 2).
    await expect(page.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "half");

    // half → full
    await handle.click();
    await expect(page.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "full");
    await assertNoHorizontalScroll(page);

    // full → peek
    await handle.click();
    await expect(page.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "peek");
    await assertNoHorizontalScroll(page);

    // peek → half (back to the default)
    await handle.click();
    await expect(page.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "half");
    await assertNoHorizontalScroll(page);

    // Build stays disabled/unclicked throughout — assert-visibility-only.
    await expect(page.getByRole("button", { name: /^build/i })).toHaveCount(0);
  });
});

test.describe("deliveries/new — mobile bottom sheet (768px)", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("tablet width still uses the map-canvas + sheet layout, no horizontal scroll", async ({
    page,
  }) => {
    await requireOrderDeliveryAddon(page);

    await page.goto("/deliveries/new");
    await assertNoHorizontalScroll(page);
    await expect(page.getByTestId("delivery-mobile-layout")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("delivery-desktop-layout")).toHaveCount(0);

    const handle = page.getByRole("button", { name: /delivery details/i });
    await handle.click();
    await expect(page.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "full");
    await assertNoHorizontalScroll(page);
  });
});

test.describe("deliveries/new — desktop (1440px, unchanged)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("lg+ keeps the classic two-column layout with no bottom sheet", async ({ page }) => {
    await requireOrderDeliveryAddon(page);

    await page.goto("/deliveries/new");
    await assertNoHorizontalScroll(page);
    await expect(page.getByTestId("delivery-desktop-layout")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("delivery-mobile-layout")).toHaveCount(0);
    await expect(page.getByTestId("delivery-sheet")).toHaveCount(0);
    // The Build button lives in the top bar at this width, not a sheet.
    await expect(page.getByRole("button", { name: /^build/i })).toBeVisible();
  });
});
