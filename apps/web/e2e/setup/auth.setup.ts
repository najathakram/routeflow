/**
 * Auth setup — runs once before the main test suites as a Playwright setup project.
 *
 * Authenticates each role (super admin, operator, customer, buyer) and saves the
 * browser storage state (cookies + localStorage) to disk. The test projects
 * for each role load this state so tests start already logged-in, avoiding
 * repeated UI logins that would exhaust the API rate-limiter.
 *
 * Storage state files are written to e2e/setup/.auth/ (gitignored).
 */
import { test as setup } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fillWorkspaceIfShown, setTenantCookie } from "../helpers/auth";
import { CREDENTIALS, HAS_SUPER_ADMIN_CREDS, TENANT_SLUG } from "../helpers/constants";

export const AUTH_DIR = path.join(__dirname, ".auth");
export const SUPER_ADMIN_AUTH = path.join(AUTH_DIR, "super-admin.json");
export const OPERATOR_AUTH = path.join(AUTH_DIR, "operator.json");
export const CUSTOMER_AUTH = path.join(AUTH_DIR, "customer.json");
export const BUYER_AUTH = path.join(AUTH_DIR, "buyer.json");

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

// ── Super Admin ────────────────────────────────────────────────────────────────

setup("authenticate as super admin", async ({ page }) => {
  if (!HAS_SUPER_ADMIN_CREDS) {
    // Write an empty storage state so dependent projects can still boot; their
    // super-admin specs skip themselves via HAS_SUPER_ADMIN_CREDS.
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(SUPER_ADMIN_AUTH, JSON.stringify({ cookies: [], origins: [] }));
    setup.skip(true, "PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD not set");
    return;
  }
  await page.goto("/admin-login");
  await page.getByPlaceholder("Platform admin username").fill(CREDENTIALS.superAdmin.username);
  await page.getByPlaceholder("Password").fill(CREDENTIALS.superAdmin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/admin/dashboard", { timeout: 60_000 });
  await page.context().storageState({ path: SUPER_ADMIN_AUTH });
});

// ── Operator ───────────────────────────────────────────────────────────────────

setup("authenticate as operator", async ({ page, context }) => {
  await setTenantCookie(context, BASE_URL, TENANT_SLUG);
  await page.goto("/login");
  await fillWorkspaceIfShown(page);
  await page.getByLabel("Username or email").fill(CREDENTIALS.operator.username);
  await page.getByPlaceholder("Enter your password").fill(CREDENTIALS.operator.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/dashboard", { timeout: 60_000 });
  await page.context().storageState({ path: OPERATOR_AUTH });
});

// ── Customer ───────────────────────────────────────────────────────────────────

setup("authenticate as customer", async ({ page, context }) => {
  await setTenantCookie(context, BASE_URL, TENANT_SLUG);
  await page.goto("/login");
  await fillWorkspaceIfShown(page);
  await page.getByLabel("Username or email").fill(CREDENTIALS.customer.username);
  await page.getByPlaceholder("Enter your password").fill(CREDENTIALS.customer.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/dashboard", { timeout: 60_000 });
  await page.context().storageState({ path: CUSTOMER_AUTH });
});

// ── Buyer ──────────────────────────────────────────────────────────────────────

// Logs in the SEEDED approved buyer (apps/api/scripts/e2e-seed.js) — it does not register one.
// The portal only resolves a seller once one is picked, which is what writes
// rf:buyer:activeSeller, so the step clicks the seller card before capturing.
setup("authenticate as buyer", async ({ page }) => {
  await page.goto("/buyer/login");
  await page.getByPlaceholder("Enter your email").fill(CREDENTIALS.buyer.email);
  await page.getByPlaceholder("Enter your password").fill(CREDENTIALS.buyer.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
  await page.waitForURL("**/buyer/portal", { timeout: 60_000 });
  await page.getByTestId("seller-card").first().click();
  await page.waitForURL("**/buyer/portal/*/orders", { timeout: 60_000 });

  const keys = await page.evaluate(() => ({
    accessToken: localStorage.getItem("rf:buyer:accessToken"),
    refreshToken: localStorage.getItem("rf:buyer:refreshToken"),
    activeSeller: localStorage.getItem("rf:buyer:activeSeller"),
  }));
  const cookies = await page.context().cookies();
  if (!keys.accessToken || !keys.refreshToken || !keys.activeSeller) {
    throw new Error(
      `buyer storage state is missing rf:buyer:* keys: ${JSON.stringify(Object.keys(keys).filter((k) => !keys[k as keyof typeof keys]))}`,
    );
  }
  if (!cookies.some((c) => c.name === "rf-buyer-auth")) {
    throw new Error("buyer storage state is missing the rf-buyer-auth cookie");
  }
  await page.context().storageState({ path: BUYER_AUTH });
});
