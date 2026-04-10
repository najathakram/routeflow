import type { Page, BrowserContext } from "@playwright/test";
import { TENANT_SLUG } from "./constants";

/**
 * Sets the tenant-slug cookie so the TenantProvider resolves the right tenant
 * without needing a subdomain. Must be called before any navigation.
 */
export async function setTenantCookie(
  context: BrowserContext,
  baseURL: string,
  slug: string = TENANT_SLUG,
) {
  await context.addCookies([
    {
      name: "tenant-slug",
      value: slug,
      url: baseURL,
      path: "/",
      httpOnly: false,
      sameSite: "Lax",
    },
  ]);
}

/**
 * Log in as the platform Super Admin.
 * Navigates to /admin-login, submits credentials, waits for /admin/dashboard.
 */
export async function loginAsSuperAdmin(page: Page) {
  await page.goto("/admin-login");
  await page.getByPlaceholder("Platform admin username").fill("najathakram");
  await page.getByPlaceholder("Password").fill("Najath123!");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/admin/dashboard", { timeout: 20_000 });
}

/**
 * Log in as the tenant Operator.
 * Requires the tenant-slug cookie to already be set (via setTenantCookie).
 */
export async function loginAsOperator(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Enter your username").fill("admin");
  await page.getByLabel("Password").or(page.getByPlaceholder("Enter your password")).fill("Admin@123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 20_000 });
}

/**
 * Log in as the harbor_cafe Customer.
 * Requires the tenant-slug cookie to already be set (via setTenantCookie).
 */
export async function loginAsCustomer(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Enter your username").fill("harbor_cafe");
  await page.getByLabel("Password").or(page.getByPlaceholder("Enter your password")).fill("Customer1!");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 20_000 });
}

/**
 * Log in as a Buyer via the /buyer/login page (email-based auth).
 */
export async function loginAsBuyer(page: Page, email: string, password: string) {
  await page.goto("/buyer/login");
  await page.getByPlaceholder("Enter your email").fill(email);
  await page.getByPlaceholder("Enter your password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/buyer/portal", { timeout: 20_000 });
}

/**
 * Clears auth tokens from localStorage so the next test starts clean.
 */
export async function logout(page: Page) {
  await page.evaluate(() => {
    [
      "accessToken",
      "refreshToken",
      "superAdminToken",
      "buyerAccessToken",
      "buyerRefreshToken",
    ].forEach((k) => localStorage.removeItem(k));
  });
}
