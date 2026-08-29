/**
 * WP12 (spec 20; 19 was taken by compliance-pack-gate): Ad-hoc delivery-trip builder
 * entitlement gate. READ-ONLY: GETs, renders, and toggling the orders-list "Select"
 * mode / a row checkbox only — Build, Create trip, and Send are never clicked.
 * Branches on the tenant's live addon state via GET /tenants/me/addons
 * (helpers/api.ts pattern, copied verbatim from 18-sales-agents-gate.spec.ts) so
 * it is green both before and after the order_delivery addon is enabled on the
 * e2e tenant. Order delivery and recurring routes are separate addons (owner
 * split 2026-08-25); since 2026-08-28 `developer_mode` no longer unlocks the GA
 * delivery features anywhere in client UI, so this spec follows the
 * `order_delivery` flag alone.
 */
import { test, expect } from "@playwright/test";
import { apiBase, operatorAccessToken } from "./helpers/api";

test("delivery-trip-builder surfaces follow the order_delivery addon flag", async ({ page }) => {
  await page.goto("/orders");
  const token = await operatorAccessToken(page);
  test.skip(!token, "no operator token — auth setup did not run");
  const res = await page.request.get(`${apiBase(page.url())}/api/v1/tenants/me/addons`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { addons = [] } = await res.json();
  const enabled = addons.includes("order_delivery");

  // Enter select mode and check the first order's row checkbox (if any orders
  // exist) to reveal the bulkbar. `table tbody tr` alone would also match the
  // loading/empty/error placeholder row, so count checkboxes instead — they
  // only render inside real order rows.
  const selectToggle = page.getByRole("button", { name: "Select", exact: true });
  await expect(selectToggle).toBeVisible({ timeout: 15_000 });
  await selectToggle.click();
  const rowCheckboxes = page.locator('table tbody tr td input[type="checkbox"]');
  const hasRows = (await rowCheckboxes.count()) > 0;
  if (hasRows) {
    await rowCheckboxes.first().check();
  }

  const planTripAction = page.getByRole("button", { name: /plan delivery trip/i });
  if (!enabled) {
    await expect(planTripAction).toHaveCount(0);
    // Deep-link bounces via the /deliveries GATED_PREFIXES entry in
    // (dashboard)/layout.tsx's RouteGuard ("delivery" need — deliveryAccess),
    // same fail-closed-once-resolved mechanism the 02-operator OP-03b canary
    // pins for /dispatch.
    await page.goto("/deliveries/new");
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  } else {
    test.skip(!hasRows, "no orders in the list to select — cannot exercise the bulkbar");
    await expect(planTripAction).toBeVisible({ timeout: 15_000 });
    // Deep-link renders the builder, not a bounce or a crash. No draft was
    // ever saved (the bulkbar action above was asserted visible, never
    // clicked), so the builder opens with the IN-PAGE ORDER PICKER (batch-d:
    // the old "go to Orders" dead-end was replaced) — assert-visibility-only:
    // nothing is added, Build stays at zero orders and is never clicked.
    await page.goto("/deliveries/new");
    await expect(page).toHaveURL(/\/deliveries\/new/);
    await expect(page.getByText("Add orders")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByPlaceholder(/search order # or customer/i)).toBeVisible();
    // The bulkbar path still exists and is mentioned as a hint, not a dead-end.
    await expect(page.getByText(/you can also select orders on the orders list/i)).toBeVisible();
    // Build always renders in PICKING phase, and canBuild requires >0 stops —
    // with no orders added it must be disabled. Assert-visibility-only: never
    // click Build/Send.
    const buildBtn = page.getByRole("button", { name: /^build/i });
    await expect(buildBtn).toBeDisabled();

    // Legacy URL still redirects to the new one (moved off /routes/trips/new
    // when order delivery became its own addon-gated surface, separate from
    // recurring routes) — bookmarks and the command palette's old href keep
    // working.
    await page.goto("/routes/trips/new");
    await expect(page).toHaveURL(/\/deliveries\/new/);
  }
});
