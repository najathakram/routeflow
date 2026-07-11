/**
 * Auth & password flows — forgot/reset pages, the session-expiry re-auth
 * sheet's Google/forgot escape hatches, and the settings Password card.
 *
 * AP-01..AP-08. No storageState: every test manages its own auth.
 *
 * NOTE: no test here mutates the seeded operator's password — that would break
 * every other spec. Server-side set/change-password mutations are covered by
 * the API Jest suites (auth/set-password.spec.ts, buyer/buyer-set-password
 * .spec.ts, buyer/buyer-password-reset.spec.ts); these tests pin the UI states.
 */

import { test, expect } from "@playwright/test";
import { loginAsOperator, logout } from "./helpers/auth";

test.describe("Auth & password flows", () => {
  // NOTE: unlike other suites, no setTenantCookie(context) here. That helper
  // injects an x-tenant-slug header on EVERY request — including the API XHRs,
  // where it collides with the header axios already sets from the tenant
  // cookie ("slug, slug" → tenant resolution fails → Invalid credentials).
  // These tests log in through the real form instead: loginAsOperator fills
  // the Workspace field, which sets the tenant cookie the normal way.

  test.afterEach(async ({ page }) => {
    await logout(page);
  });

  // ── Forgot / reset pages ────────────────────────────────────────────────────

  test("AP-01 login page links to forgot-password", async ({ page }) => {
    await page.goto("/login");
    const link = page.getByRole("link", { name: "Forgot password?" });
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL("**/forgot-password");
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  });

  test("AP-02 forgot-password is enumeration-safe (unknown address shows the same success)", async ({
    page,
  }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(`e2e_nobody_${Date.now()}@example.com`);
    await page.getByRole("button", { name: "Send reset link" }).click();
    // Always flips to the generic success state — never confirms existence.
    await expect(page.getByText("Check your inbox")).toBeVisible();
    await expect(page.getByText(/If that address is registered/)).toBeVisible();
  });

  test("AP-03 reset-password without a token shows the invalid-link state", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByText(/invalid or incomplete/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Request a new reset link" })).toBeVisible();
  });

  test("AP-04 reset-password with a bogus token is rejected by the server", async ({ page }) => {
    await page.goto("/reset-password?token=bogus-e2e-token");
    await page.getByLabel("New password", { exact: true }).fill("FreshPass1!");
    await page.getByLabel("Confirm new password").fill("FreshPass1!");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.getByText(/invalid|already been used|expired/i)).toBeVisible();
  });

  // ── Session-expiry re-auth sheet ────────────────────────────────────────────

  /**
   * Expire the session IN PLACE, mirroring the real mid-session timeout: the
   * dashboard is already mounted (AuthGuard passed at mount), then the access
   * token goes stale and the refresh token dies. A subsequent CLIENT-SIDE
   * navigation fires data queries that 401 → silent refresh fails → the
   * re-auth sheet opens over the still-mounted app. (A full page.goto would
   * instead re-run AuthGuard's mount check and bounce to /login — a different,
   * legitimate path that this suite is not about.)
   */
  async function expireSessionInPlace(page: import("@playwright/test").Page) {
    await page.evaluate(() => {
      const key = "rf:op:accessToken";
      const token = localStorage.getItem(key);
      if (!token) throw new Error("no operator token after login");
      const [h, p] = token.split(".");
      const payload = JSON.parse(atob(p!.replace(/-/g, "+").replace(/_/g, "/")));
      payload.exp = Math.floor(Date.now() / 1000) - 3600;
      const b64 = (obj: unknown) =>
        btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      localStorage.setItem(key, `${h}.${b64(payload)}.invalidsig`);
      localStorage.setItem("rf:op:refreshToken", "corrupted-refresh-token");
    });
    // Client-side navigation (no full page load) → new page components mount
    // and fetch → 401 → refresh fails → sheet.
    await page.getByRole("link", { name: "Customers" }).first().click();
  }

  test("AP-05 re-auth sheet offers password, Google, and forgot-password", async ({ page }) => {
    await loginAsOperator(page);
    await expireSessionInPlace(page);

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole("button", { name: "Unlock and continue" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Forgot password?" })).toBeVisible();
    // Do NOT click Google — it would navigate the suite off the app.
  });

  test("AP-06 re-auth sheet unlock with the correct password resumes the session", async ({
    page,
  }) => {
    await loginAsOperator(page);
    await expireSessionInPlace(page);

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.locator("#reauth-pw").fill("Admin@123");
    await dialog.getByRole("button", { name: "Unlock and continue" }).click();
    await expect(dialog).not.toBeVisible({ timeout: 20_000 });
    // Session restored in place — still inside the dashboard, no /login bounce.
    await expect(page).not.toHaveURL(/\/login/);
  });

  // ── Settings password card ──────────────────────────────────────────────────

  test("AP-07 settings shows the Password card in change mode for a password account", async ({
    page,
  }) => {
    await loginAsOperator(page);
    await page.goto("/settings");
    // Generous wait: in `next dev` the settings page compiles on first hit.
    const accountTab = page.getByRole("tab", { name: /My Account/i });
    await expect(accountTab).toBeVisible({ timeout: 45_000 });
    await accountTab.click();
    await expect(page.getByText("Change your account password", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Change password" }).click();
    // Change mode = current-password field present (set mode hides it).
    await expect(page.getByLabel("Current password")).toBeVisible();
    await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
    // Client-side mismatch validation — no server mutation.
    await page.getByLabel("New password", { exact: true }).fill("FreshPass1!");
    await page.getByLabel("Confirm new password").fill("Different1!");
    await page.getByRole("button", { name: "Change password" }).last().click();
    await expect(page.getByText("Passwords do not match")).toBeVisible();
  });

  // ── Buyer parity ────────────────────────────────────────────────────────────

  test("AP-08 buyer login links to buyer forgot-password (enumeration-safe)", async ({ page }) => {
    await page.goto("/buyer/login");
    const link = page.getByRole("link", { name: "Forgot password?" });
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL("**/buyer/forgot-password");
    await page.getByLabel("Email").fill(`e2e_nobody_${Date.now()}@example.com`);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("Check your inbox")).toBeVisible();
  });
});
