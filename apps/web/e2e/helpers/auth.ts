import type { Page, BrowserContext } from "@playwright/test";
import { TENANT_SLUG } from "./constants";

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
  await page.getByPlaceholder("Platform admin username").fill("najathakram");
  await page.getByPlaceholder("Password").fill("Najath123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/admin/dashboard", { timeout: 30_000 });
}

/**
 * Log in as the tenant Operator.
 * Requires the tenant-slug cookie to already be set (via setTenantCookie).
 */
export async function loginAsOperator(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Enter your username").fill("admin");
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
  await page.getByPlaceholder("Enter your username").fill("harbor_cafe");
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
 */
export async function logout(page: Page) {
  await page.evaluate(() => {
    try {
      [
        "accessToken",
        "refreshToken",
        "superAdminToken",
        "buyerAccessToken",
        "buyerRefreshToken",
      ].forEach((k) => localStorage.removeItem(k));
    } catch {
      // Ignore SecurityError when page is about:blank or cross-origin
    }
  }).catch(() => {});
}
