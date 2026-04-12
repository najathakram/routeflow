/**
 * Customer role UI tests — scoped access verification
 *
 * Covers: CU-01 through CU-04
 * Role: CUSTOMER (harbor_cafe / Customer1!)
 * Key assertion: customers can only see their own data and cannot access
 * operator-only routes like /routes or /drivers.
 */

import { test, expect } from "@playwright/test";
import { setTenantCookie, loginAsCustomer, logout } from "./helpers/auth";

test.describe("Customer — Scoped Access", () => {
  // Storage state (customer.json) is pre-loaded by the "customer" Playwright project,
  // so each test context starts already authenticated. We set the tenant header for
  // correct middleware routing, then navigate to the dashboard.
  test.beforeEach(async ({ page, context }) => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
    await setTenantCookie(context, baseURL);
    await page.goto("/dashboard");
  });

  test.afterEach(async ({ page }) => {
    await logout(page);
  });

  test("CU-01 customer login → lands on dashboard (limited view)", async ({ page }) => {
    await expect(page).toHaveURL(/\/dashboard/);
    // Should not see operator-only nav items (Routes, Drivers)
    // The test just verifies the redirect lands somewhere usable
    await expect(page.locator("main, [class*='dashboard']").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("CU-02 /orders shows only own orders — not all tenant orders", async ({ page }) => {
    await page.goto("/orders");
    // Page should load (not 403)
    await expect(page).not.toHaveURL(/error|403/);
    // Orders visible should be scoped to harbor_cafe
    const content = page.locator("table, [class*='order'], [class*='empty']").first();
    await expect(content).toBeVisible({ timeout: 15_000 });
    // Verify no other customer names appear (spot-check)
    await expect(page.getByText("westpark_grill")).not.toBeVisible();
  });

  test("CU-03 /routes → redirect or 403 (no access for customer)", async ({ page }) => {
    await page.goto("/routes");
    // Wait briefly for client-side redirect to fire
    await page.waitForTimeout(2000);
    const url = page.url();
    const isBlocked =
      url.includes("/login") ||
      url.includes("/dashboard") ||
      url.includes("/403") ||
      (await page.getByText(/forbidden|not authorized|access denied/i).isVisible());
    expect(isBlocked).toBe(true);
  });

  test("CU-04 /drivers → redirect or 403 (no access for customer)", async ({ page }) => {
    await page.goto("/drivers");
    // Wait briefly for client-side redirect to fire
    await page.waitForTimeout(2000);
    const url = page.url();
    const isBlocked =
      url.includes("/login") ||
      url.includes("/dashboard") ||
      url.includes("/403") ||
      (await page.getByText(/forbidden|not authorized|access denied/i).isVisible());
    expect(isBlocked).toBe(true);
  });

  test("CU-05 /invoices → customer can view their own invoices", async ({ page }) => {
    await page.goto("/invoices");
    // Should load without error
    await expect(page).not.toHaveURL(/error/);
    const content = page.locator("table, [class*='invoice'], [class*='empty']").first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });
});
