/**
 * WP12 (spec 20; 19 was taken by compliance-pack-gate): Ad-hoc delivery-trip builder
 * entitlement gate. READ-ONLY: GETs, renders, and toggling the orders-list "Select"
 * mode / a row checkbox only — Build, Create trip, and Send are never clicked.
 * Branches on the tenant's live addon state via GET /tenants/me/addons
 * (helpers/api.ts pattern, copied verbatim from 18-sales-agents-gate.spec.ts) so
 * it is green both before and after the developer_mode / order_delivery addons
 * are enabled on the e2e tenant. Order delivery and recurring routes are now
 * separate addons (owner split 2026-08-25); this spec follows the union flag
 * `developer_mode || order_delivery`, since `developer_mode` still unlocks
 * every in-development surface as the master switch.
 */
import { test, expect } from "@playwright/test";
import { apiBase, operatorAccessToken } from "./helpers/api";

test("delivery-trip-builder surfaces follow the developer_mode/order_delivery addon flags", async ({
  page,
}) => {
  await page.goto("/orders");
  const token = await operatorAccessToken(page);
  test.skip(!token, "no operator token — auth setup did not run");
  const res = await page.request.get(`${apiBase(page.url())}/api/v1/tenants/me/addons`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { addons = [] } = await res.json();
  const enabled = addons.includes("developer_mode") || addons.includes("order_delivery");

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
    // (dashboard)/layout.tsx's RouteGuard ("delivery" need — devMode ||
    // deliveryAccess), same fail-closed-once-resolved mechanism the
    // 02-operator OP-03b canary pins for /dispatch.
    await page.goto("/deliveries/new");
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  } else {
    test.skip(!hasRows, "no orders in the list to select — cannot exercise the bulkbar");
    await expect(planTripAction).toBeVisible({ timeout: 15_000 });
    // Deep-link renders the builder, not a bounce or a crash. No draft was
    // ever saved (the bulkbar action above was asserted visible, never
    // clicked), so the builder shows its instructive empty state rather than
    // the picking/build/send flow — assert-visibility-only, Build is never
    // reachable in this state by construction.
    await page.goto("/deliveries/new");
    await expect(page).toHaveURL(/\/deliveries\/new/);
    // Match the empty-state body copy specifically, not just "Plan a delivery" —
    // the dashboard shell's page-title <h1> now reads that exact same string
    // (both were updated to "Plan a delivery" when this builder moved off
    // /routes/trips/new), so a bare text match on that phrase would resolve to
    // two elements and violate Playwright's strict mode.
    await expect(page.getByText(/select orders from the orders list/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: /go to orders/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^build/i })).toHaveCount(0);

    // Legacy URL still redirects to the new one (moved off /routes/trips/new
    // when order delivery became its own addon-gated surface, separate from
    // recurring routes) — bookmarks and the command palette's old href keep
    // working.
    await page.goto("/routes/trips/new");
    await expect(page).toHaveURL(/\/deliveries\/new/);
  }
});
