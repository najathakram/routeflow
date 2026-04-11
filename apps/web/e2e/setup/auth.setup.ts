/**
 * Auth setup — runs once before the main test suites as a Playwright setup project.
 *
 * Authenticates each role (super admin, operator, customer) and saves the
 * browser storage state (cookies + localStorage) to disk. The test projects
 * for each role load this state so tests start already logged-in, avoiding
 * repeated UI logins that would exhaust the API rate-limiter.
 *
 * Storage state files are written to e2e/setup/.auth/ (gitignored).
 */
import { test as setup } from "@playwright/test";
import path from "path";
import { setTenantCookie } from "../helpers/auth";
import { CREDENTIALS, TENANT_SLUG } from "../helpers/constants";

export const AUTH_DIR = path.join(__dirname, ".auth");
export const SUPER_ADMIN_AUTH = path.join(AUTH_DIR, "super-admin.json");
export const OPERATOR_AUTH = path.join(AUTH_DIR, "operator.json");
export const CUSTOMER_AUTH = path.join(AUTH_DIR, "customer.json");

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ?? "https://app.routeflow.io";

// ── Super Admin ────────────────────────────────────────────────────────────────

setup("authenticate as super admin", async ({ page }) => {
  await page.goto("/admin-login");
  await page
    .getByPlaceholder("Platform admin username")
    .fill(CREDENTIALS.superAdmin.username);
  await page.getByPlaceholder("Password").fill(CREDENTIALS.superAdmin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/admin/dashboard", { timeout: 60_000 });
  await page.context().storageState({ path: SUPER_ADMIN_AUTH });
});

// ── Operator ───────────────────────────────────────────────────────────────────

setup("authenticate as operator", async ({ page, context }) => {
  await setTenantCookie(context, BASE_URL, TENANT_SLUG);
  await page.goto("/login");
  await page
    .getByPlaceholder("Enter your username")
    .fill(CREDENTIALS.operator.username);
  await page
    .getByPlaceholder("Enter your password")
    .fill(CREDENTIALS.operator.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/dashboard", { timeout: 60_000 });
  await page.context().storageState({ path: OPERATOR_AUTH });
});

// ── Customer ───────────────────────────────────────────────────────────────────

setup("authenticate as customer", async ({ page, context }) => {
  await setTenantCookie(context, BASE_URL, TENANT_SLUG);
  await page.goto("/login");
  await page
    .getByPlaceholder("Enter your username")
    .fill(CREDENTIALS.customer.username);
  await page
    .getByPlaceholder("Enter your password")
    .fill(CREDENTIALS.customer.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/dashboard", { timeout: 60_000 });
  await page.context().storageState({ path: CUSTOMER_AUTH });
});
