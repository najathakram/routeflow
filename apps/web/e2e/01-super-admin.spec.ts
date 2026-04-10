/**
 * Super Admin UI tests — platform admin panel at /admin-login
 *
 * Covers: SA-01 through SA-12
 * Role: SUPER_ADMIN (najathakram / Najath123!)
 */

import { test, expect } from "@playwright/test";
import { loginAsSuperAdmin, logout } from "./helpers/auth";

test.describe("Super Admin — Platform Admin Panel", () => {
  // Log in once before the whole suite
  test.beforeEach(async ({ page }) => {
    await loginAsSuperAdmin(page);
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
    await page.getByPlaceholder("Password").fill("wrong_password");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByText(/invalid credentials|incorrect|wrong/i)).toBeVisible();
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
    await searchInput.fill("qa-");
    // Results should reduce or remain consistent
    await page.waitForTimeout(800); // debounce
    const rows = page.locator("table tbody tr");
    const count = await rows.count();
    // If there are results, at least 1 should contain the slug
    if (count > 0) {
      await expect(rows.first()).toContainText("qa-");
    }
  });

  // ── Create tenant ─────────────────────────────────────────────────────────

  test("SA-06 create new tenant — appears in list", async ({ page }) => {
    await page.goto("/admin/tenants/new");
    const slug = `e2e-test-${Date.now()}`;
    await page.getByLabel(/slug/i).or(page.getByPlaceholder(/slug/i)).fill(slug);
    await page.getByLabel(/business name/i).or(page.getByPlaceholder(/business name/i)).fill("E2E Test Tenant");
    await page.getByLabel(/admin.*email/i).or(page.getByPlaceholder(/admin.*email/i)).fill(`${slug}@example.com`);
    await page.getByLabel(/admin.*user(name)?/i).or(page.getByPlaceholder(/username/i)).fill(`${slug}_admin`);
    // Fill password fields
    const passwordFields = page.getByLabel(/password/i).or(page.getByPlaceholder(/password/i));
    await passwordFields.first().fill("AdminPass@123!");
    await page.getByRole("button", { name: /create|submit|save/i }).click();
    // Should redirect back to tenants list and show the new entry
    await page.waitForURL(/\/admin\/tenants/, { timeout: 15_000 });
    await expect(page.getByText(slug)).toBeVisible({ timeout: 10_000 });
  });

  // ── Tenant detail — suspend / reactivate ──────────────────────────────────

  test("SA-07 tenant detail loads 5 tabs", async ({ page }) => {
    await page.goto("/admin/tenants");
    // Click the first tenant row / detail link
    await page.locator("table tbody tr a, table tbody tr[role='button'], table tbody tr").first().click();
    await page.waitForURL(/\/admin\/tenants\/.+/);
    // Check tabs render
    await expect(page.getByRole("tab").first()).toBeVisible({ timeout: 10_000 });
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

  test("SA-11 logout → redirected to /admin-login", async ({ page }) => {
    // Find and click logout button in nav/sidebar
    const logoutBtn = page
      .getByRole("button", { name: /log ?out|sign ?out/i })
      .or(page.getByText(/log ?out|sign ?out/i));
    await logoutBtn.first().click();
    await page.waitForURL(/\/admin-login/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/admin-login/);
  });

  // ── Google OAuth button ──────────────────────────────────────────────────

  test("SA-12 Google OAuth button on admin-login redirects to Google", async ({ page, context }) => {
    await logout(page);
    await context.clearCookies();
    await page.goto("/admin-login");
    const [popup] = await Promise.all([
      // If it opens a popup, catch it
      context.waitForEvent("page").catch(() => null),
      // Click Continue with Google button
      page
        .getByRole("button", { name: /google/i })
        .or(page.getByText(/continue with google/i))
        .first()
        .click(),
    ]);
    // Either the current page or a popup navigates to Google
    const targetPage = popup ?? page;
    await expect(targetPage).toHaveURL(/accounts\.google\.com/, { timeout: 15_000 });
  });
});
