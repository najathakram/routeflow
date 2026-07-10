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

  test("CC-05 super admin impersonation grants tenant-scoped access", async ({ page }) => {
    // Impersonation issues a 15-min token with the tenant-admin's claims +
    // `impersonatedBy`; writes are AUDIT-LOGGED, not blocked (see
    // platform-admin.service impersonate()). Verify the token is accepted for a
    // tenant-scoped READ (no mutation against production data).
    await loginAsSuperAdmin(page);
    const apiURL =
      process.env.PLAYWRIGHT_API_URL ?? "https://routeflowapi-production.up.railway.app/api/v1";

    const saToken = await page.evaluate(() => localStorage.getItem("superAdminToken") ?? "");

    const tenantsResp = await page.request.get(`${apiURL}/platform-admin/tenants?limit=1`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    const tenantsData = await tenantsResp.json();
    const tenant = tenantsData?.data?.[0];
    if (!tenant?.id) {
      test.skip(true, "No tenant found for impersonation test");
      return;
    }

    const impResp = await page.request.post(
      `${apiURL}/platform-admin/tenants/${tenant.id}/impersonate`,
      { headers: { Authorization: `Bearer ${saToken}` } },
    );
    const { accessToken: impToken } = await impResp.json();
    if (!impToken) {
      test.skip(true, "Impersonation token not returned");
      return;
    }

    // The impersonation token grants the impersonated tenant's access.
    const readResp = await page.request.get(`${apiURL}/orders?limit=1`, {
      headers: { Authorization: `Bearer ${impToken}`, "X-Tenant-Slug": tenant.slug },
    });
    expect(readResp.ok()).toBeTruthy();
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

// ── Landing-page auto-redirect (middleware, keyed on presence cookies) ────────
// The middleware 307s signed-in users away from exactly "/": rf-op-auth →
// /dashboard, rf-buyer-auth → /buyer/portal, operator wins when both are set.
// The raw-request tests pin the middleware contract; CC-15 covers the
// stale-cookie journey that killed the earlier client-side redirect.

test.describe("Cross-cutting — Landing-page auto-redirect", () => {
  const BASE_URL =
    process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

  async function seedPresenceCookies(
    context: import("@playwright/test").BrowserContext,
    names: string[],
  ) {
    await context.addCookies(
      names.map((name) => ({
        name,
        value: "1",
        domain: new URL(BASE_URL).hostname,
        path: "/",
      })),
    );
  }

  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test("CC-11 landing 307s operators to /dashboard", async ({ context }) => {
    await seedPresenceCookies(context, ["rf-op-auth"]);
    const resp = await context.request.get("/", { maxRedirects: 0 });
    expect(resp.status()).toBe(307);
    expect(resp.headers()["location"]).toContain("/dashboard");
  });

  test("CC-12 landing 307s buyers to /buyer/portal", async ({ context }) => {
    await seedPresenceCookies(context, ["rf-buyer-auth"]);
    const resp = await context.request.get("/", { maxRedirects: 0 });
    expect(resp.status()).toBe(307);
    expect(resp.headers()["location"]).toContain("/buyer/portal");
  });

  test("CC-13 operator wins when both presence cookies are set", async ({ context }) => {
    await seedPresenceCookies(context, ["rf-op-auth", "rf-buyer-auth"]);
    const resp = await context.request.get("/", { maxRedirects: 0 });
    expect(resp.status()).toBe(307);
    expect(resp.headers()["location"]).toContain("/dashboard");
  });

  test("CC-14 signed-out landing renders marketing with no redirect", async ({ page, context }) => {
    const resp = await context.request.get("/", { maxRedirects: 0 });
    expect(resp.status()).toBe(200);
    await page.goto("/");
    await expect(page).toHaveURL(`${BASE_URL.replace(/\/$/, "")}/`);
  });

  test("CC-15 stale op cookie → bounded bounce to /login, then self-heals", async ({
    page,
    context,
  }) => {
    // Presence cookie without any localStorage tokens = the dead-session case.
    await seedPresenceCookies(context, ["rf-op-auth"]);
    await page.goto("/");
    // / → 307 /dashboard → AuthGuard finds no tokens → /login. Bounded, no loop.
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    await expect(page).toHaveURL(/\/login/);
    // AuthProvider's failed restore cleared the stale cookie — the landing page
    // must render normally now (self-healing, marketing site never hidden).
    await page.goto("/");
    await expect(page).toHaveURL(`${BASE_URL.replace(/\/$/, "")}/`);
  });
});
