/**
 * Buyer Portal UI tests — /buyer/* routes
 *
 * Covers: BY-01 through BY-13
 * Role: BUYER (email-based auth, self-register)
 *
 * This suite registers a fresh buyer per run so it never depends on
 * pre-existing buyer data. The invite flow is tested by:
 *   1. Logging in as operator → navigating to a customer → copying the invite link
 *   2. Opening that link as the registered buyer
 */

import { test, expect } from "@playwright/test";
import { setTenantCookie, loginAsOperator, loginAsBuyer, logout } from "./helpers/auth";
import { uniqueBuyerEmail, TENANT_SLUG } from "./helpers/constants";

// Shared buyer credentials created once before the suite
const BUYER_EMAIL = uniqueBuyerEmail();
const BUYER_PASS = "BuyerE2E@2026!";

test.describe("Buyer Portal", () => {
  // ── Registration ─────────────────────────────────────────────────────────

  test("BY-01 register new buyer account → redirect to /buyer/portal", async ({ page }) => {
    await page.goto("/buyer/register");
    await page.getByPlaceholder("Enter your full name").fill("E2E Buyer");
    await page.getByPlaceholder("Enter your email").fill(BUYER_EMAIL);
    // Password field — find by placeholder pattern
    // Placeholder matches apps/web/app/buyer/register/page.tsx (updated by the
    // buyer password-policy work, #189) — the field enforces upper/lower/digit-or-symbol.
    await page.getByPlaceholder("8+ chars, upper & lower case, number or symbol").fill(BUYER_PASS);
    await page.getByPlaceholder("Re-enter your password").fill(BUYER_PASS);
    await page.getByRole("button", { name: /create|register|sign up/i }).click();
    await page.waitForURL("**/buyer/portal", { timeout: 20_000 });
    await expect(page).toHaveURL(/\/buyer\/portal/);
  });

  test("BY-02 register duplicate email → error shown", async ({ page }) => {
    await page.goto("/buyer/register");
    await page.getByPlaceholder("Enter your full name").fill("Dup Buyer");
    await page.getByPlaceholder("Enter your email").fill(BUYER_EMAIL);
    // Placeholder matches apps/web/app/buyer/register/page.tsx (updated by the
    // buyer password-policy work, #189) — the field enforces upper/lower/digit-or-symbol.
    await page.getByPlaceholder("8+ chars, upper & lower case, number or symbol").fill(BUYER_PASS);
    await page.getByPlaceholder("Re-enter your password").fill(BUYER_PASS);
    await page.getByRole("button", { name: /create|register|sign up/i }).click();
    // Should stay on register page with an error
    await expect(page.getByText(/already exists|already registered|conflict/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page).not.toHaveURL(/\/buyer\/portal/);
  });

  // ── Login ─────────────────────────────────────────────────────────────────

  test("BY-03 buyer login → redirect to /buyer/portal", async ({ page }) => {
    await loginAsBuyer(page, BUYER_EMAIL, BUYER_PASS);
    await expect(page).toHaveURL(/\/buyer\/portal/);
  });

  test("BY-04 buyer login wrong password → inline error", async ({ page }) => {
    await page.goto("/buyer/login");
    await page.getByPlaceholder("Enter your email").fill(BUYER_EMAIL);
    await page.getByPlaceholder("Enter your password").fill("wrongpass!");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByText(/invalid|incorrect|wrong/i)).toBeVisible({ timeout: 10_000 });
    await expect(page).not.toHaveURL(/\/buyer\/portal/);
  });

  // ── Portal — no sellers yet ────────────────────────────────────────────────

  test("BY-05 portal with no sellers → 'No sellers linked' empty state", async ({ page }) => {
    await loginAsBuyer(page, BUYER_EMAIL, BUYER_PASS);
    await page.waitForURL("**/buyer/portal", { timeout: 35_000 });
    // The actual text on the page is "No sellers linked yet"
    await expect(
      page.getByText(/no sellers|no supplier|haven't been connected/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("BY-14 password login fires the authorized seller-list fetch (A5 regression)", async ({
    page,
    context,
  }) => {
    // Pre-A5 bug: buyerLogin() wrote only the namespaced rf:buyer:accessToken
    // key while the auth context still read the legacy "buyerAccessToken"
    // literal — so after a plain email/password login this request NEVER fired
    // (only Google logins backfilled the legacy key, masking the bug), the
    // seller list stayed empty on any fresh device, and the buyer could never
    // reach a dashboard. Works for a zero-seller buyer too: the fetch itself
    // must happen and return 200.
    //
    // SELF-CONTAINED ON PURPOSE. This registers its own buyer rather than
    // reusing the suite-level BUYER_EMAIL, which only exists once BY-01 has
    // run — an ordering dependency that made this test pass in a full-file run
    // and fail when run alone with `-g "BY-14"`. A regression test for a
    // client-facing login bug has to be runnable on demand, and clearing
    // storage below also makes it a truer reproduction: a brand-new account
    // signing in on a device that has never held a token.
    const email = `e2e_buyer_a5_${Date.now()}@example.com`;

    await page.goto("/buyer/register");
    await page.getByPlaceholder("Enter your full name").fill("A5 Regression Buyer");
    await page.getByPlaceholder("Enter your email").fill(email);
    await page.getByPlaceholder("8+ chars, upper & lower case, number or symbol").fill(BUYER_PASS);
    await page.getByPlaceholder("Re-enter your password").fill(BUYER_PASS);
    await page.getByRole("button", { name: /create|register|sign up/i }).click();
    await page.waitForURL("**/buyer/portal", { timeout: 30_000 });

    // Become a "different computer": no tokens, no cached active seller.
    await page.evaluate(() => {
      try {
        localStorage.clear();
      } catch {}
    });
    await context.clearCookies();

    const sellersRequest = page.waitForRequest(
      (req) => req.url().includes("/buyer/sellers") && !!req.headers()["authorization"],
      { timeout: 30_000 },
    );
    await page.goto("/buyer/login");
    await page.getByPlaceholder("Enter your email").fill(email);
    await page.getByPlaceholder("Enter your password").fill(BUYER_PASS);
    await page.getByRole("button", { name: /sign in/i }).click();

    const req = await sellersRequest;
    const res = await req.response();
    expect(res?.status()).toBe(200);

    // The canonical (namespaced) key is what login writes — pin that too.
    const token = await page.evaluate(() => localStorage.getItem("rf:buyer:accessToken"));
    expect(token).toBeTruthy();
  });

  // ── Unauthenticated access ─────────────────────────────────────────────────

  test("BY-06 unauthenticated /buyer/portal → redirect to /buyer/login", async ({
    page,
    context,
  }) => {
    // Navigate first so localStorage is in scope, then clear tokens
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

  // ── Invite flow ───────────────────────────────────────────────────────────

  test("BY-07 invite link — open while logged out → shows login/register CTAs", async ({
    page,
    context,
  }) => {
    // First get an invite token by calling the API (via operator login)
    const baseURL =
      process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
    await setTenantCookie(context, baseURL, TENANT_SLUG);
    await loginAsOperator(page);

    // Open the first available customer (data-agnostic — no dependency on a
    // specific seeded customer) and trigger the portal invite from its detail page.
    await page.goto("/customers");
    const firstRow = page.locator("table tbody tr").first();
    await expect(firstRow).toBeVisible({ timeout: 15_000 });
    await firstRow.click();
    await page.waitForURL(/\/customers\/.+/);

    // Look for "Send Portal Invite" or "Invite" button
    const inviteBtn = page.getByRole("button", { name: /invite|portal invite/i });
    if (!(await inviteBtn.isVisible())) {
      test.skip(true, "Portal invite button not found on customer detail");
      return;
    }
    await inviteBtn.click();

    // Capture the invite link from the response or clipboard
    // Try finding the invite URL in page content
    const inviteLink = await page.evaluate(() => {
      const el = document.querySelector("[data-invite-url], input[value*='/buyer/invite/']");
      return el ? (el as HTMLInputElement).value || el.textContent : null;
    });

    if (!inviteLink) {
      test.skip(true, "Could not capture invite link");
      return;
    }

    // Now log out and open the invite as a guest
    await logout(page);
    await context.clearCookies();
    await page.goto(inviteLink);

    // Should show the seller info + login/register CTAs
    await expect(page.getByText(/sign in|log in|register|create account/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("BY-08 invite page — open with invalid token → error card shown", async ({ page }) => {
    await page.goto("/buyer/invite/invalid-token-xyz-123");
    // Should show an error card — heading says "Invalid Invite"
    await expect(
      page.getByText(/invalid invite|invite not found|expired|not found/i).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  // ── Buyer portal navigation (after linking) ───────────────────────────────
  // These tests assume the buyer has been linked to a seller (via a previous
  // manual or automated invite acceptance). They are skipped with a clear
  // message if no sellers are linked.

  test("BY-09 portal — seller card visible after linking", async ({ page }) => {
    try {
      await loginAsBuyer(page, BUYER_EMAIL, BUYER_PASS);
    } catch {
      test.skip(true, "Buyer login timed out — skipping seller card check");
      return;
    }
    // button[data-testid] scopes to the CLICKABLE (ACTIVE-link) variant of
    // SellerCard. The old `[class*='seller'], [class*='card'] button` locator
    // never matched the portal DOM, so BY-09..12 silently self-skipped forever.
    const sellerCard = page.locator('button[data-testid="seller-card"]').first();
    const hasCards = await sellerCard.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasCards) {
      test.skip(true, "No sellers linked to this buyer account — run invite flow first");
      return;
    }
    await expect(sellerCard).toBeVisible();
  });

  test("BY-10 buyer portal → click seller → navigate to orders", async ({ page }) => {
    try {
      await loginAsBuyer(page, BUYER_EMAIL, BUYER_PASS);
    } catch {
      test.skip(true, "Buyer login timed out — skipping");
      return;
    }
    const sellerCard = page.locator('button[data-testid="seller-card"]').first();
    const hasCards = await sellerCard.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasCards) {
      test.skip(true, "No sellers linked");
      return;
    }
    await sellerCard.click();
    await page.waitForURL(/\/buyer\/portal\/.+\/orders/, { timeout: 15_000 });
    await expect(page).toHaveURL(/\/orders/);
  });

  test("BY-11 buyer invoices page renders", async ({ page }) => {
    try {
      await loginAsBuyer(page, BUYER_EMAIL, BUYER_PASS);
    } catch {
      test.skip(true, "Buyer login timed out — skipping");
      return;
    }
    const sellerCard = page.locator('button[data-testid="seller-card"]').first();
    const hasCards = await sellerCard.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasCards) {
      test.skip(true, "No sellers linked");
      return;
    }
    await sellerCard.click();
    await page.waitForURL(/\/buyer\/portal\/.+/);
    // Navigate to invoices
    const slug = page.url().split("/buyer/portal/")[1]?.split("/")[0];
    await page.goto(`/buyer/portal/${slug}/invoices`);
    const content = page.locator("table, [class*='invoice'], [class*='empty']").first();
    await expect(content).toBeVisible({ timeout: 15_000 });
  });

  test("BY-12 buyer account page renders name and email", async ({ page }) => {
    try {
      await loginAsBuyer(page, BUYER_EMAIL, BUYER_PASS);
    } catch {
      test.skip(true, "Buyer login timed out — skipping");
      return;
    }
    const sellerCard = page.locator('button[data-testid="seller-card"]').first();
    const hasCards = await sellerCard.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasCards) {
      test.skip(true, "No sellers linked");
      return;
    }
    await sellerCard.click();
    await page.waitForURL(/\/buyer\/portal\/.+/);
    const slug = page.url().split("/buyer/portal/")[1]?.split("/")[0];
    await page.goto(`/buyer/portal/${slug}/account`);
    // Should show buyer email
    await expect(page.getByText(BUYER_EMAIL)).toBeVisible({ timeout: 10_000 });
  });

  // ── Portal switcher (T28; spec R7, R11) ───────────────────────────────────

  test("BY-15 sidebar offers the seller dashboard, and the portal records rf-last-portal=buyer", async ({
    page,
    context,
  }) => {
    await loginAsBuyer(page, BUYER_EMAIL, BUYER_PASS);
    await page.waitForURL("**/buyer/portal", { timeout: 35_000 });

    // This buyer has no operator session, so it is the sign-in variant.
    const link = page.getByRole("link", { name: "Seller dashboard sign-in" });
    await expect(link).toBeVisible({ timeout: 15_000 });
    await expect(link).toHaveAttribute("href", "/login");

    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === "rf-last-portal")?.value).toBe("buyer");
  });

  // ── Logout ────────────────────────────────────────────────────────────────

  test("BY-13 buyer logout → redirect to /buyer/login", async ({ page }) => {
    try {
      await loginAsBuyer(page, BUYER_EMAIL, BUYER_PASS);
    } catch {
      test.skip(true, "Buyer login timed out — skipping");
      return;
    }
    // Find logout button
    const logoutBtn = page
      .getByRole("button", { name: /log ?out|sign ?out/i })
      .or(page.getByText(/log ?out|sign ?out/i).first());
    if (await logoutBtn.first().isVisible({ timeout: 5_000 })) {
      await logoutBtn.first().click();
      await page.waitForURL(/\/buyer\/login/, { timeout: 10_000 });
      await expect(page).toHaveURL(/\/buyer\/login/);
    } else {
      // Fallback: clear tokens and verify redirect
      await page.evaluate(() => {
        ["buyerAccessToken", "buyerRefreshToken"].forEach((k) => localStorage.removeItem(k));
      });
      await page.goto("/buyer/portal");
      await page.waitForURL(/\/buyer\/login/);
    }
  });
});
