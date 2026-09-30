/**
 * Lite-L2 (WP10): the LITE-plan sidebar/route gate (R4.3/R4.5/R7.7), Settings → Billing's
 * "Complete payment" (R2.5/R2.8), and choose-plan/marketing never rendering a "Lite" card
 * (R2.2/R2.6/R3b.8). Flows copied verbatim from
 * `.claude/pipeline/2026-09-15-lite-L2-plan/ux-spec.md` §"Playwright verification flows".
 *
 * Fixture: a dedicated `e2e-lite` (or similarly `e2e-*`-slugged) tenant on plan LITE,
 * seeded with the same operator credentials `loginAsOperator` (helpers/auth.ts) already
 * assumes for `e2e-routeflow` (admin / Admin@123). Set its slug via
 * PLAYWRIGHT_LITE_TENANT_SLUG; every test below self-skips (test.skip — not a discharge,
 * L-041) when it is unset, since none of them can run against the shared operator.json
 * fixture (that tenant is not on LITE). READ-ONLY throughout: nothing here creates,
 * enables, or pays for anything — "Complete payment"/"See plans" are asserted visible and
 * clicked only as far as the resulting navigation, never completed against Stripe.
 *
 * AUTHOR-ONLY per the lite-L2 dispatch: this spec has not been run (no browser/compose
 * available in that session) — typecheck only.
 */
import { test, expect } from "@playwright/test";
import { setTenantCookie, loginAsOperator } from "./helpers/auth";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const RAW_LITE_SLUG = process.env.PLAYWRIGHT_LITE_TENANT_SLUG ?? "";
const LITE_TENANT_SLUG = RAW_LITE_SLUG
  ? assertTestTenant(RAW_LITE_SLUG, "playwright e2e (lite-plan-gate)")
  : "";
const SKIP_REASON = "PLAYWRIGHT_LITE_TENANT_SLUG not set — needs a dedicated LITE-plan tenant";

/** Gated-nav labels PLAN_GATED_NAV covers (lib/plan-gated-nav.ts) — a LITE tenant with
 *  none of these flags must see none of these entries. Dispatch/Sales Agents are
 *  deliberately excluded: they're gated by separate addon hooks, not plan flags. */
const GATED_LABELS = [
  "Estimates",
  "Credit Notes",
  "Returns",
  "Suppliers",
  "Bills & Purchasing",
  "Reports",
  "Analytics",
];
/** Always-ungated top-level entries every plan (including LITE) keeps. */
const UNGATED_LABELS = ["Dashboard", "All Orders", "Customers", "Inventory", "Products"];

async function loginAsLiteOperator(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
  baseURL: string | undefined,
) {
  await setTenantCookie(context, baseURL ?? "", LITE_TENANT_SLUG);
  await loginAsOperator(page); // navigates to /login itself
}

test.describe("Lite-plan nav/route gating (lite-L2)", () => {
  test("1. a LITE tenant's sidebar hides every plan-gated entry and keeps the ungated ones", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!LITE_TENANT_SLUG, SKIP_REASON);
    await loginAsLiteOperator(page, context, baseURL);

    const nav = page.getByRole("navigation");
    for (const label of UNGATED_LABELS) {
      await expect(nav.getByText(label, { exact: true })).toBeVisible();
    }
    for (const label of GATED_LABELS) {
      await expect(nav.getByText(label, { exact: true })).toHaveCount(0);
    }
  });

  test("2. direct navigation to a gated route renders the locked panel, not an error toast", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!LITE_TENANT_SLUG, SKIP_REASON);
    await loginAsLiteOperator(page, context, baseURL);

    await page.goto("/estimates");
    await expect(page.getByRole("heading", { name: "Not on your plan" })).toBeVisible();
    await expect(page.getByRole("button", { name: /see plans/i })).toBeVisible();
    await expect(page.getByText(/isn't included in the .* plan/i)).toBeVisible();
    // No error toast — a client-side plan gate must never surface as a toast (that path
    // is reserved for a server-side PLAN_GATE 403 the client didn't already know about).
    await expect(
      page.getByRole("region", { name: /notifications/i }).getByRole("listitem"),
    ).toHaveCount(0);
  });

  test("3. See plans leads to choose-plan with no Lite card", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!LITE_TENANT_SLUG, SKIP_REASON);
    await loginAsLiteOperator(page, context, baseURL);

    await page.goto("/estimates");
    await page.getByRole("button", { name: /see plans/i }).click();
    await page.waitForURL("**/choose-plan", { timeout: 30_000 });

    await expect(page.getByText("Lite", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Starter", { exact: true })).toBeVisible();
  });

  test("4. the e2e-routeflow (non-LITE) sidebar label list is unchanged", async ({ page }) => {
    test.skip(!LITE_TENANT_SLUG, SKIP_REASON);
    // Uses the project's own storageState (operator.json, e2e-routeflow / STARTER-class) —
    // already authenticated, no fresh login needed.
    await page.goto("/dashboard");

    // Top-level rendered entries only (groups start collapsed; their children aren't in
    // the DOM's visible-text set until expanded) — an explicit committed array, not a
    // snapshot (CP-07: read each row's own text, never a container's concatenated
    // textContent).
    const topLevel = page.getByRole("navigation").locator("> ul > li");
    const labels = (await topLevel.allInnerTexts()).map((t) => t.trim()).filter(Boolean);

    expect(labels).toEqual([
      "Dashboard",
      "Orders",
      "Dispatch",
      "Customers",
      "Warehouse",
      "Finance",
      "Analytics",
      "Settings",
    ]);
  });

  test("5. Settings → Billing header follows the LITE tenant's live status", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!LITE_TENANT_SLUG, SKIP_REASON);
    await loginAsLiteOperator(page, context, baseURL);

    await page.goto("/settings/billing");
    await expect(page.getByText("Lite", { exact: true }).first()).toBeVisible();

    // Branches on the tenant's live status (read-only, no mutation) — same pattern
    // 18-sales-agents-gate.spec.ts uses for a live addon flag: green either way.
    const completePayment = page.getByRole("button", { name: "Complete payment" });
    const isActive = await page
      .getByText("ACTIVE", { exact: true })
      .isVisible()
      .catch(() => false);
    if (isActive) {
      await expect(completePayment).toHaveCount(0);
    } else {
      await expect(completePayment).toBeVisible();
    }
  });

  test("6. the unauthenticated marketing pricing page never renders a Lite plan", async ({
    page,
  }) => {
    test.skip(!LITE_TENANT_SLUG, SKIP_REASON);
    await page.goto("/pricing");
    await expect(page.getByText("Lite", { exact: true })).toHaveCount(0);
  });
});
