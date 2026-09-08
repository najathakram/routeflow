/**
 * TP-E2E — auth interface redesign (spec 46), project "auth-redesign".
 *
 * Proves (post-deploy only, per test-plan.md "Harness notes" — NEVER run
 * locally; Playwright is never run inside the dev-pipeline engine): R6, R7,
 * R9, R10, R12.
 *
 * R13 (`rf-auth-success` on every success/done container) is NOT proven here —
 * those states need a live token/email, so they are fenced statically by T2i in
 * `app/(auth)/auth-redesign.static.test.ts`.
 *
 * Signed-out throughout — no storageState, dependencies: [] on the
 * "auth-redesign" project (playwright.config.ts). Tenant host detection for
 * T5f delegates to `lib/tenant-host.ts` — the single source of truth the
 * middleware and the login page already share; never re-inline those rules.
 *
 * Fails TODAY: `main#main-content.rf-auth` does not exist on any of these
 * routes (the AuthShell port has not landed on this deployment yet), so
 * every T5a/T5b/T5d assertion misses on its own concrete value.
 */
import { test, expect } from "@playwright/test";
import { tenantSlugFromHostname } from "../lib/tenant-host";

// spec.md's copy table (h1 exact strings), the 6 routes T5a/T5b/T5c pin.
const H1_BY_ROUTE: Record<string, string> = {
  "/login": "Welcome back.",
  "/signup": "Your next chapter starts here.",
  "/forgot-password": "Reset your password",
  "/reset-password": "Choose a new password",
  "/buyer/login": "Welcome back.",
  "/buyer/register": "Your next chapter starts here.",
};

const DESKTOP_ROUTES = Object.keys(H1_BY_ROUTE);

// Host classification has exactly ONE source of truth: `lib/tenant-host.ts`
// (shared with `middleware.ts` and the login page). A local copy of the rules
// is how form login broke on the Railway fallback URL once already — that
// module's header says "Do not re-inline either set".
function isTenantHost(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  return tenantSlugFromHostname(new URL(baseURL).hostname) !== null;
}

// ─── T5a/T5b/T5c — desktop chrome + labels + cross-links (R6 R7 R10 R12) ────

test.describe("T5 — desktop (1280x800) auth chrome, copy and labels (R6 R7 R10 R12)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const route of DESKTOP_ROUTES) {
    test(`T5a — ${route}: rf-auth shell, one h1 = copy table, Need help? -> /contact`, async ({
      page,
    }) => {
      await page.goto(route);

      const main = page.locator("main#main-content.rf-auth");
      await expect(main).toBeVisible();

      const story = page.locator(".rf-auth-story");
      await expect(story).toBeVisible();
      const storyBox = await story.boundingBox();
      expect(storyBox?.width ?? 0).toBeGreaterThan(400);

      const h1 = page.getByRole("heading", { level: 1 });
      await expect(h1).toHaveCount(1);
      await expect(h1).toHaveText(H1_BY_ROUTE[route]!);

      await expect(page.getByRole("link", { name: "Need help?" })).toHaveAttribute(
        "href",
        "/contact",
      );

      await page.screenshot({
        path: `test-output/auth-redesign/${route.replace(/\//g, "-")}-desktop.png`,
      });
    });
  }

  test("T5b — /login labels resolve: Workspace, Username or email, Password, Sign in", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Workspace")).toBeVisible();
    await expect(page.getByLabel("Username or email")).toBeVisible();
    // `exact: true` — a lax getByLabel also matches PasswordInput's toggle
    // button (aria-label "Show password"), a strict-mode violation. Same
    // convention as e2e/07-auth-password.spec.ts.
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  });

  test("T5b — /buyer/login labels resolve: Email, Password, Sign in", async ({ page }) => {
    await page.goto("/buyer/login");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true }).first()).toBeVisible();
  });

  test("T5b — /forgot-password labels resolve: Email, Send reset link", async ({ page }) => {
    await page.goto("/forgot-password");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByRole("button", { name: /send reset link/i })).toBeVisible();
  });

  test("T5b — /reset-password (no token) shows the invalid-link message", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByText(/invalid or incomplete/)).toBeVisible();
  });

  test("T5c — /login cross-links: Forgot password? and buyer-portal sign-in", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("link", { name: "Forgot password?" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
    await expect(page.getByRole("link", { name: /sign in to the buyer portal/i })).toHaveAttribute(
      "href",
      "/buyer/login",
    );
    await expect(page.getByText(/retailer portal/i)).toHaveCount(0);
    await expect(page.getByText(/staff portal/i)).toHaveCount(0);
  });

  test("T5c — /buyer/login cross-link: seller-dashboard sign-in", async ({ page }) => {
    await page.goto("/buyer/login");
    await expect(
      page.getByRole("link", { name: /sign in to the seller dashboard/i }),
    ).toHaveAttribute("href", "/login");
    await expect(page.getByText(/retailer portal/i)).toHaveCount(0);
    await expect(page.getByText(/staff portal/i)).toHaveCount(0);
  });
});

// ─── T5e — accessibility (R12) ───────────────────────────────────────────────

test.describe("T5e — accessibility (R12)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const route of ["/login", "/buyer/login"]) {
    test(`T5e — ${route}: manual a11y checks`, async ({ page }) => {
      await page.goto(route);

      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

      const inputs = page.locator("input:not([type=hidden])");
      const inputCount = await inputs.count();
      let labelledCount = 0;
      for (let i = 0; i < inputCount; i++) {
        const input = inputs.nth(i);
        const id = await input.getAttribute("id");
        const ariaLabel = await input.getAttribute("aria-label");
        const ariaLabelledBy = await input.getAttribute("aria-labelledby");
        if (ariaLabel || ariaLabelledBy) {
          labelledCount++;
          continue;
        }
        if (id) {
          const label = page.locator(`label[for="${id}"]`);
          if ((await label.count()) > 0) labelledCount++;
        }
      }
      expect(labelledCount).toBe(inputCount);

      // The shell's OWN ring, not Chrome's default: `.rf-auth :focus-visible`
      // is `outline: 2px solid var(--rf-navy); outline-offset: 2px`. The UA
      // fallback reports outline-style "auto", so deleting that rule goes red
      // here (an `outlineStyle !== "none"` oracle would not).
      await page.keyboard.press("Tab");
      const focusRing = await page.evaluate(() => {
        const el = document.activeElement as Element;
        const cs = getComputedStyle(el);
        return {
          inside: !!el.closest(".rf-auth"),
          width: cs.outlineWidth,
          style: cs.outlineStyle,
          offset: cs.outlineOffset,
        };
      });
      expect(focusRing).toEqual({ inside: true, width: "2px", style: "solid", offset: "2px" });
    });
  }
});

// ─── T5d — mobile (375x812, desktop UA — NEVER a phone device preset) ───────
// A phone UA is proxied away from /login by design (build-plan.md P5 note).

test.describe("T5d — mobile (375x812) chrome (R6)", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  for (const route of ["/login", "/buyer/login"]) {
    test(`T5d — ${route}: slim story band, card visible, no horizontal overflow`, async ({
      page,
    }) => {
      await page.goto(route);

      await expect(page.locator(".rf-auth-story-copy")).toBeHidden();

      const storyBox = await page.locator(".rf-auth-story").boundingBox();
      expect(storyBox?.height ?? 9999).toBeLessThan(140);

      await expect(page.locator(".rf-auth-card")).toBeVisible();

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(375);

      await page.screenshot({
        path: `test-output/auth-redesign/${route.replace(/\//g, "-")}-mobile.png`,
      });
    });
  }
});

// ─── T5f — tenant-branded login (R9) ────────────────────────────────────────

test.describe("T5f — tenant logo on a tenant subdomain host (R9)", () => {
  test("T5f — /login on a tenant host shows the tenant logo, not the Workspace field", async ({
    page,
    baseURL,
  }) => {
    test.skip(!isTenantHost(baseURL), "this run's baseURL is a platform host, not a tenant host");

    await page.goto("/login");
    await expect(page.getByLabel("Workspace")).toHaveCount(0);

    const logo = page.locator(".rf-auth-card img");
    await expect(logo).toBeVisible();
    const alt = await logo.getAttribute("alt");
    expect(alt).toBeTruthy();
  });
});
