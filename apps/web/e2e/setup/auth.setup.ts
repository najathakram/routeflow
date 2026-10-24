/**
 * Auth setup — runs once before the main test suites as a Playwright setup project.
 *
 * Authenticates each role (super admin, operator, tenant admin, customer, buyer) and saves the
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
import { CREDENTIALS, HAS_SUPER_ADMIN_CREDS, TENANT_SLUG, isLocalUrl } from "../helpers/constants";
import { assertSafeSetupTarget } from "../../lib/e2e-setup-guard";

export const AUTH_DIR = path.join(__dirname, ".auth");
export const SUPER_ADMIN_AUTH = path.join(AUTH_DIR, "super-admin.json");
export const OPERATOR_AUTH = path.join(AUTH_DIR, "operator.json");
export const TENANT_ADMIN_AUTH = path.join(AUTH_DIR, "tenant-admin.json");
export const CUSTOMER_AUTH = path.join(AUTH_DIR, "customer.json");
export const BUYER_AUTH = path.join(AUTH_DIR, "buyer.json");

// Fail-closed (lib/e2e-setup-guard.ts): this throws at load — before any page opens or any
// password is typed — unless PLAYWRIGHT_BASE_URL is set to a local http(s) target and the tenant
// is an approved test tenant. GitHub Actions and a human's explicit E2E_ALLOW_REMOTE_AUTH=1 are
// the only sanctioned remote paths; an agent must never set that variable.
const { baseUrl: BASE_URL } = assertSafeSetupTarget();

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

// ── Tenant admin ───────────────────────────────────────────────────────────────

// Account-administration specs (settings import / migration / numbering / email) need admin
// rights, which the OPERATOR above will not have once those endpoints are restricted to admins.
// Seeded by apps/api/scripts/e2e-seed.js (e2e_admin) on the e2e-routeflow tenant.
setup("authenticate as tenant admin", async ({ page, context }) => {
  await setTenantCookie(context, BASE_URL, TENANT_SLUG);
  await page.goto("/login");
  await fillWorkspaceIfShown(page);
  await page.getByLabel("Username or email").fill(CREDENTIALS.tenantAdmin.username);
  await page.getByPlaceholder("Enter your password").fill(CREDENTIALS.tenantAdmin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/dashboard", { timeout: 60_000 });
  await page.context().storageState({ path: TENANT_ADMIN_AUTH });
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
// rf:buyer:activeSeller, so the step clicks the seller card before capturing. Only an ACTIVE link
// renders the card as a <button> (a pending one is a <div>), hence the button selector.
setup("authenticate as buyer", async ({ page, baseURL }) => {
  // First line of output, so whoever mints sees where this is pointing (an unset
  // PLAYWRIGHT_BASE_URL is now refused at load by assertSafeSetupTarget above).
  console.log(`[buyer setup] base URL: ${baseURL ?? "(unset)"}`);
  // The buyer is seeded on LOCAL databases only (a committed throwaway password on a global
  // account), so never contact a non-local target: skip before any request, and write nothing —
  // no dependent project loads buyer.json, and a missing file stops a prover loudly.
  if (!isLocalUrl(baseURL)) {
    setup.skip(true, "buyer fixture is seeded on local targets only");
    return;
  }
  await page.goto("/buyer/login");
  await page.getByPlaceholder("Enter your email").fill(CREDENTIALS.buyer.email);
  await page.getByPlaceholder("Enter your password").fill(CREDENTIALS.buyer.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
  // Race the success URL against the form's inline API error so a failed login is told apart from
  // a hang: a 401 ("Invalid email or password.") means the buyer is not seeded here -> skip; any
  // other outcome throws with the page state, so a red run explains itself.
  const errorText = page.getByText(/invalid email or password|login failed/i).first();
  const outcome = await Promise.race([
    page.waitForURL("**/buyer/portal", { timeout: 30_000 }).then(() => "portal" as const),
    errorText.waitFor({ timeout: 30_000 }).then(() => "error" as const),
  ]).catch(async (err: unknown) => {
    const formText = await page
      .locator("form")
      .first()
      .innerText()
      .catch(() => "(no form)");
    throw new Error(
      `buyer login neither reached /buyer/portal nor showed an error: url=${page.url()} form=${JSON.stringify(formText)} cause=${String(err)}`,
    );
  });
  if (outcome === "error") {
    const shown = (await errorText.innerText()).trim();
    if (/invalid email or password/i.test(shown)) {
      // Local, but the buyer is not seeded (or its password drifted) - run the e2e seed.
      setup.skip(
        true,
        "seeded buyer could not log in - run the e2e seed against the local database",
      );
      return;
    }
    throw new Error(`buyer login failed with an unexpected message: ${shown}`);
  }
  await page.locator('button[data-testid="seller-card"]').first().click();
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
