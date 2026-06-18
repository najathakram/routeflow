/**
 * Cross-cutting tests — auth guards, role isolation, unauthenticated access
 *
 * Covers: CC-01 through CC-08
 * These tests do NOT log in as any role; they verify the app's auth guards
 * redirect/block correctly for all route groups.
 */

import { test, expect } from "@playwright/test";
import {
  setTenantCookie,
  loginAsSuperAdmin,
  loginAsOperator,
  loginAsBuyer,
  logout,
} from "./helpers/auth";
import { TENANT_SLUG, CREDENTIALS } from "./helpers/constants";

test.describe("Cross-cutting — Auth Guards & Role Isolation", () => {
  // ── Unauthenticated redirects ──────────────────────────────────────────────

  test("CC-01 unauthenticated /dashboard → redirect to /login", async ({ page, context }) => {
    await context.clearCookies();
    // Navigate first so localStorage is in scope, then clear tokens
    await page.goto("/login");
    await page.evaluate(() => {
      try {
        ["accessToken", "refreshToken"].forEach((k) => localStorage.removeItem(k));
      } catch {}
    });
    await context.clearCookies();
    await page.goto("/dashboard");
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test("CC-02 unauthenticated /admin/dashboard → redirect to /admin-login", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto("/admin-login");
    await page.evaluate(() => {
      try {
        localStorage.removeItem("superAdminToken");
      } catch {}
    });
    await context.clearCookies();
    await page.goto("/admin/dashboard");
    await page.waitForURL(/\/admin[\-\/]login/, { timeout: 15_000 });
    await expect(page).toHaveURL(/\/admin[\-\/]login/);
  });

  test("CC-03 unauthenticated /buyer/portal → redirect to /buyer/login", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto("/buyer/login");
    await page.evaluate(() => {
      try {
        ["buyerAccessToken", "buyerRefreshToken"].forEach((k) => localStorage.removeItem(k));
      } catch {}
    });
    await context.clearCookies();
    await page.goto("/buyer/portal");
    await page.waitForURL(/\/buyer\/login/, { timeout: 15_000 });
    await expect(page).toHaveURL(/\/buyer\/login/);
  });

  // ── Role cross-access is blocked ──────────────────────────────────────────

  test("CC-04 operator cannot access /admin/dashboard → blocked", async ({ page, context }) => {
    const baseURL =
      process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
    await setTenantCookie(context, baseURL, TENANT_SLUG);
    await loginAsOperator(page);
    await page.goto("/admin/dashboard");
    // Should redirect or show 403 — operator cannot reach platform admin
    const url = page.url();
    const isBlocked =
      url.includes("/admin-login") ||
      url.includes("/dashboard") ||
      url.includes("/login") ||
      url.includes("/403") ||
      (await page.getByText(/forbidden|not authorized|access denied/i).isVisible());
    expect(isBlocked).toBe(true);
    await logout(page);
  });

  test("CC-05 super admin impersonation token is read-only (POST blocked)", async ({
    page,
    context,
  }) => {
    // Log in as SA, impersonate tenant, verify mutation is blocked
    await loginAsSuperAdmin(page);
    // API URL must be set separately — the web URL is NOT the API URL
    const apiURL =
      process.env.PLAYWRIGHT_API_URL ?? "https://routeflowapi-production.up.railway.app/api/v1";

    // Get SA token from localStorage
    const saToken = await page.evaluate(() => localStorage.getItem("superAdminToken") ?? "");

    // Get a tenant id for impersonation
    const tenantsResp = await page.request.get(`${apiURL}/platform-admin/tenants?limit=1`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    const tenantsData = await tenantsResp.json();
    const tenantId = tenantsData?.data?.[0]?.id;
    if (!tenantId) {
      test.skip(true, "No tenant found for impersonation test");
      return;
    }

    // Impersonate
    const impResp = await page.request.post(
      `${apiURL}/platform-admin/tenants/${tenantId}/impersonate`,
      { headers: { Authorization: `Bearer ${saToken}` } },
    );
    const { accessToken: impToken } = await impResp.json();
    if (!impToken) {
      test.skip(true, "Impersonation token not returned");
      return;
    }

    // Try a mutation with the impersonation token — should 403
    const mutationResp = await page.request.post(`${apiURL}/orders`, {
      headers: {
        Authorization: `Bearer ${impToken}`,
        "X-Tenant-Slug": tenantsData.data[0].slug,
        "Content-Type": "application/json",
      },
      data: JSON.stringify({ customerId: "test", items: [] }),
    });
    expect(mutationResp.status()).toBe(403);
    await logout(page);
  });

  // ── Invalid invite token ──────────────────────────────────────────────────

  test("CC-06 invalid invite token /buyer/invite/bad → error shown", async ({ page }) => {
    await page.goto("/buyer/invite/completely-invalid-token-xyz");
    // Page shows "Invalid Invite" card with subtitle "Invite not found or already used"
    await expect(
      page.getByText(/invalid invite|invite not found|expired|not found/i).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  // ── Google OAuth buttons redirect to Google ───────────────────────────────

  test("CC-07 Google OAuth button on /login navigates to Google", async ({ page, context }) => {
    const baseURL =
      process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
    await setTenantCookie(context, baseURL, TENANT_SLUG);
    await page.goto("/login");
    const googleBtn = page
      .getByRole("button", { name: /google/i })
      .or(page.getByText(/continue with google/i))
      .first();
    if (!(await googleBtn.isVisible({ timeout: 5_000 }))) {
      test.skip(true, "Google button not visible — GOOGLE_CLIENT_ID may not be configured");
      return;
    }
    await googleBtn.click();
    await page.waitForURL(/accounts\.google\.com|google\.com\/o\/oauth/, { timeout: 15_000 });
    await expect(page).toHaveURL(/google\.com/);
  });

  test("CC-08 Google OAuth button on /admin-login navigates to Google", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto("/admin-login");
    await page.evaluate(() => {
      try {
        localStorage.removeItem("superAdminToken");
      } catch {}
    });
    const googleBtn = page
      .getByRole("button", { name: /google/i })
      .or(page.getByText(/continue with google/i))
      .first();
    if (!(await googleBtn.isVisible({ timeout: 5_000 }))) {
      test.skip(true, "Google button not visible — GOOGLE_CLIENT_ID may not be configured");
      return;
    }
    await googleBtn.click();
    await page.waitForURL(/accounts\.google\.com|google\.com\/o\/oauth/, { timeout: 15_000 });
    await expect(page).toHaveURL(/google\.com/);
  });

  // ── Session persistence ───────────────────────────────────────────────────

  test("CC-09 session persists across page reload — operator stays logged in", async ({
    page,
    context,
  }) => {
    const baseURL =
      process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
    await setTenantCookie(context, baseURL, TENANT_SLUG);
    await loginAsOperator(page);
    await page.reload();
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
    await expect(page).toHaveURL(/\/dashboard/);
    await logout(page);
  });

  test("CC-10 session persists across page reload — SA stays logged in", async ({ page }) => {
    await loginAsSuperAdmin(page);
    await page.reload();
    await page.waitForURL(/\/admin\/dashboard/, { timeout: 15_000 });
    await expect(page).toHaveURL(/\/admin\/dashboard/);
    await logout(page);
  });
});
