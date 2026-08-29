import type { Page, BrowserContext } from "@playwright/test";
import { CREDENTIALS, TENANT_SLUG } from "./constants";

/**
 * Injects the x-tenant-slug request header for all subsequent navigations.
 *
 * The Next.js middleware reads this header and sets the tenant-slug cookie in
 * the response. Using setExtraHTTPHeaders is necessary because the middleware
 * always rewrites the cookie from DEFAULT_TENANT on Railway URLs (no subdomain).
 */
export async function setTenantCookie(
  context: BrowserContext,
  _baseURL: string,
  slug: string = TENANT_SLUG,
) {
  await context.setExtraHTTPHeaders({ "x-tenant-slug": slug });
}

/**
 * Log in as the platform Super Admin.
 * Navigates to /admin-login, submits credentials, waits for /admin/dashboard.
 */
export async function loginAsSuperAdmin(page: Page) {
  await page.goto("/admin-login");
  await page.getByPlaceholder("Platform admin username").fill(CREDENTIALS.superAdmin.username);
  await page.getByPlaceholder("Password").fill(CREDENTIALS.superAdmin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/admin/dashboard", { timeout: 30_000 });
}

/**
 * The login form requires a Workspace (tenant slug) on hosts without a real
 * tenant subdomain. On the Railway prod URL the page derives one from the
 * hostname so the field is hidden; on localhost it is visible and REQUIRED —
 * without filling it, zod blocks the submit and login never navigates.
 */
export async function fillWorkspaceIfShown(page: Page, slug: string = TENANT_SLUG) {
  // Single atomic attempt rather than isVisible()-then-fill: that pair races with
  // hydration. The server-rendered form can show the field for a frame before the
  // client derives the tenant from the hostname and drops it, so isVisible() returns
  // true and the following fill() then burns the full 20s actionTimeout on a node
  // that no longer exists — which is what turned the setup project red on Railway
  // (operator failed outright, customer went flaky on the same code path).
  //
  // fill() auto-waits, so a field that appears mid-hydration is still handled; one
  // that never appears costs only this short timeout. Swallowing the miss is safe and
  // does NOT mask a real failure: if the workspace value were actually required, the
  // waitForURL("**/dashboard") immediately after this call fails loudly instead.
  try {
    await page.getByLabel("Workspace").fill(slug, { timeout: 5_000 });
  } catch {
    // No Workspace field on this host — the tenant comes from the hostname/header.
  }
}

/**
 * Log in as the tenant Operator.
 * Requires the tenant-slug cookie to already be set (via setTenantCookie).
 */
export async function loginAsOperator(page: Page) {
  await page.goto("/login");
  await fillWorkspaceIfShown(page);
  // The reskinned login form labels the username field "Username or email"
  // (placeholder "you@company.com"); match by label, like auth.setup does.
  await page.getByLabel("Username or email").fill("admin");
  await page.getByPlaceholder("Enter your password").fill("Admin@123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
}

/**
 * Log in as the harbor_cafe Customer.
 * Requires the tenant-slug cookie to already be set (via setTenantCookie).
 */
export async function loginAsCustomer(page: Page) {
  await page.goto("/login");
  await fillWorkspaceIfShown(page);
  await page.getByLabel("Username or email").fill("harbor_cafe");
  await page.getByPlaceholder("Enter your password").fill("Customer1!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
}

/**
 * Log in as a Buyer via the /buyer/login page (email-based auth).
 */
export async function loginAsBuyer(page: Page, email: string, password: string) {
  await page.goto("/buyer/login");
  await page.getByPlaceholder("Enter your email").fill(email);
  await page.getByPlaceholder("Enter your password").fill(password);
  // Use first() in case multiple elements match (e.g., "Sign in" + "Sign in with Google")
  await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
  await page.waitForURL("**/buyer/portal", { timeout: 30_000 });
}

/**
 * Clears auth tokens from localStorage so the next test starts clean.
 * Silently ignores SecurityError thrown on about:blank or cross-origin pages.
 * NEW-m2-1 / RF-077: includes both namespaced and legacy key names.
 */
export async function logout(page: Page) {
  await page
    .evaluate(() => {
      try {
        [
          // Namespaced keys (post-NEW-m2-1)
          "rf:op:accessToken",
          "rf:op:refreshToken",
          "rf:buyer:accessToken",
          "rf:buyer:refreshToken",
          "rf:buyer:activeSeller",
          // Legacy keys (pre-migration; kept here so old sessions are also wiped)
          "accessToken",
          "refreshToken",
          "buyerAccessToken",
          "buyerRefreshToken",
          "superAdminToken",
        ].forEach((k) => localStorage.removeItem(k));
      } catch {
        // Ignore SecurityError when page is about:blank or cross-origin
      }
    })
    .catch(() => {});
}
