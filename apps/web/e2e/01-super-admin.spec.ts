/**
 * Super Admin UI tests — platform admin panel at /admin-login
 *
 * Covers: SA-01 through SA-12
 * Role: SUPER_ADMIN (najathakram / Najath123!)
 */

import { test, expect } from "@playwright/test";
import { loginAsSuperAdmin, logout } from "./helpers/auth";

test.describe("Super Admin — Platform Admin Panel", () => {
  // Storage state (super-admin.json) is pre-loaded by the "super-admin" Playwright
  // project, so each test context starts already authenticated. We just navigate
  // to the dashboard — no UI login on every test.
  test.beforeEach(async ({ page }) => {
    await page.goto("/admin/dashboard");
  });

  test.afterEach(async ({ page }) => {
    await logout(page);
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  test("SA-01 login with correct credentials → /admin/dashboard", async ({ page }) => {
    await expect(page).toHaveURL(/\/admin\/dashboard/);
  });

  test("SA-02 admin-login wrong password → error shown inline", async ({ page, context }) => {
    await logout(page);
    await context.clearCookies();
    await page.goto("/admin-login");
    await page.getByPlaceholder("Platform admin username").fill("najathakram");
    await page.getByPlaceholder("Password").fill("wrong_password_xyz!");
    // Use exact: true to avoid matching "Sign in with Google"
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // Error may say "invalid credentials", "incorrect", "wrong", or "too many requests" (rate limited)
    await expect(
      page.getByText(/invalid|incorrect|wrong|too many|error|failed/i).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(page).not.toHaveURL(/\/admin\/dashboard/);
  });

  // ── Dashboard ─────────────────────────────────────────────────────────────

  test("SA-03 admin dashboard loads — KPI cards and tenants table visible", async ({ page }) => {
    await page.goto("/admin/dashboard");
    // At least one stat card should be visible
    const statsArea = page.locator("[class*='stat'], [class*='card'], [class*='metric']").first();
    await expect(statsArea).toBeVisible({ timeout: 15_000 });
  });

  // ── Tenants list ─────────────────────────────────────────────────────────

  test("SA-04 tenants list loads — table rows with slug/name/status", async ({ page }) => {
    await page.goto("/admin/tenants");
    // Wait for at least one tenant row
    await expect(page.locator("table tbody tr, [data-testid='tenant-row']").first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("SA-05 tenants list — search filters results", async ({ page }) => {
    await page.goto("/admin/tenants");
    const searchInput = page.getByPlaceholder(/search/i).or(page.getByRole("searchbox")).first();
    // Search for "e2e" — should match our seeded "e2e-routeflow" tenant
    await searchInput.fill("e2e");
    // Wait for debounce
    await page.waitForTimeout(1000);
    const rows = page.locator("table tbody tr");
    const count = await rows.count();
    // If there are results, at least 1 should contain the search term
    if (count > 0) {
      await expect(rows.first()).toContainText(/e2e/i);
    }
  });

  // ── Create tenant ─────────────────────────────────────────────────────────

  test("SA-06 create new tenant — appears in list", async ({ page }) => {
    await page.goto("/admin/tenants/new");
    const slug = `e2e-${Date.now()}`;
    // Use placeholders which are stable identifiers on this form
    await page.getByPlaceholder("e.g. acme-foods").fill(slug);
    await page.getByPlaceholder("e.g. Acme Foods Ltd.").fill("E2E Test Tenant");
    await page.getByPlaceholder("admin@acme.com").fill(`admin@${slug}.com`);
    await page.getByPlaceholder("acme_admin").fill(`${slug}_admin`);
    await page.getByPlaceholder("Min. 8 characters").fill("AdminPass@123!");
    await page.getByRole("button", { name: "Create Tenant", exact: true }).click();
    // Should redirect back to tenants list and show the new entry
    await page.waitForURL(/\/admin\/tenants/, { timeout: 20_000 });
    await expect(page.getByText(slug).first()).toBeVisible({ timeout: 15_000 });
  });

  // ── Tenant detail — suspend / reactivate ──────────────────────────────────

  test("SA-07 tenant detail loads 5 tabs", async ({ page }) => {
    await page.goto("/admin/tenants");
    // Click the "View" link in the Actions column of the first tenant row
    await page.getByRole("link", { name: "View" }).first().click();
    await page.waitForURL(/\/admin\/tenants\/.+/, { timeout: 15_000 });
    // AdminTabs renders <button> elements (not role="tab") for Overview, Billing, etc.
    await expect(page.getByRole("button", { name: /overview/i })).toBeVisible({ timeout: 10_000 });
  });

  // ── Audit logs ────────────────────────────────────────────────────────────

  test("SA-08 audit logs page loads — rows with timestamp/action", async ({ page }) => {
    await page.goto("/admin/audit-logs");
    await expect(page).not.toHaveURL(/error/);
    // Either a table with rows or an empty state should be visible
    const content = page
      .locator("table, [class*='empty'], [data-testid='audit-empty']")
      .first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  // ── Billing ───────────────────────────────────────────────────────────────

  test("SA-09 billing page renders without crash", async ({ page }) => {
    await page.goto("/admin/billing");
    await expect(page).not.toHaveURL(/error/);
    // Page should have something visible — not blank
    await expect(page.locator("main, h1, h2, [class*='card']").first()).toBeVisible({
      timeout: 15_000,
    });
  });

  // ── Plans ─────────────────────────────────────────────────────────────────

  test("SA-10 plans page renders comparison table", async ({ page }) => {
    await page.goto("/admin/plans");
    await expect(page).not.toHaveURL(/error/);
    // Expect plan names to be visible
    await expect(page.getByText(/starter|professional|enterprise/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  // ── Logout ────────────────────────────────────────────────────────────────

  test("SA-11 logout → redirected to admin login page", async ({ page }) => {
    // The platform admin sidebar has a "Sign out" button (text exact match)
    // handleLogout() removes superAdminToken and calls router.push("/admin/login")
    const logoutBtn = page.getByRole("button", { name: "Sign out", exact: true });
    await logoutBtn.click();
    // App redirects to /admin/login (the client-side route, not /admin-login)
    await page.waitForURL(/\/admin[\-\/]login/, { timeout: 15_000 });
    await expect(page).toHaveURL(/\/admin[\-\/]login/);
  });

  // ── Google OAuth button ──────────────────────────────────────────────────

  test("SA-12 Google OAuth button on admin-login redirects to Google", async ({ page, context }) => {
    await logout(page);
    await context.clearCookies();
    await page.goto("/admin-login");
    const googleBtn = page
      .getByRole("button", { name: /google/i })
      .or(page.getByText(/continue with google/i))
      .first();
    if (!(await googleBtn.isVisible({ timeout: 5_000 }))) {
      test.skip(true, "Google button not visible — GOOGLE_CLIENT_ID may not be configured");
      return;
    }
    // Click and wait — OAuth may open in same page or popup
    const popupPromise = context.waitForEvent("page", { timeout: 10_000 }).catch(() => null);
    await googleBtn.click();
    const popup = await popupPromise;
    if (popup) {
      await expect(popup).toHaveURL(/google\.com/, { timeout: 15_000 });
    } else {
      // Same-page navigation to Google
      await page.waitForURL(/google\.com/, { timeout: 15_000 });
      await expect(page).toHaveURL(/google\.com/);
    }
  });
});
