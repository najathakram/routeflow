/**
 * WP12 (19): Ad-hoc trip builder entitlement gate. READ-ONLY: GETs, renders,
 * and toggling the orders-list "Select" mode / a row checkbox only — Build,
 * Create trip, and Send are never clicked. Branches on the tenant's live addon
 * state via GET /tenants/me/addons (helpers/api.ts pattern, copied verbatim
 * from 18-sales-agents-gate.spec.ts) so it is green both before and after the
 * developer_mode addon is enabled on the e2e tenant.
 */
import { test, expect } from "@playwright/test";
import { apiBase, operatorAccessToken } from "./helpers/api";

test("trip-builder surfaces follow the developer_mode addon flag", async ({ page }) => {
  await page.goto("/orders");
  const token = await operatorAccessToken(page);
  test.skip(!token, "no operator token — auth setup did not run");
  const res = await page.request.get(`${apiBase(page.url())}/api/v1/tenants/me/addons`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { addons = [] } = await res.json();
  const enabled = addons.includes("developer_mode");

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
    // Deep-link bounces via the inherited /routes prefix gate — trip UI lives
    // under DEV_MODE_PREFIXES in (dashboard)/layout.tsx, no gating code of its
    // own, same mechanism the 02-operator OP-03b canary pins for /dispatch.
    await page.goto("/routes/trips/new");
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  } else {
    test.skip(!hasRows, "no orders in the list to select — cannot exercise the bulkbar");
    await expect(planTripAction).toBeVisible({ timeout: 15_000 });
    // Deep-link renders the builder, not a bounce or a crash. No draft was
    // ever saved (the bulkbar action above was asserted visible, never
    // clicked), so the builder shows its instructive empty state rather than
    // the picking/build/send flow — assert-visibility-only, Build is never
    // reachable in this state by construction.
    await page.goto("/routes/trips/new");
    await expect(page).toHaveURL(/\/routes\/trips\/new/);
    await expect(page.getByText(/plan a delivery trip/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /go to orders/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^build/i })).toHaveCount(0);
  }
});
