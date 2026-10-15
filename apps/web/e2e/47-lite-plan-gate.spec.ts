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
 * Authored without a browser (typecheck only); first run against a real stack in row 489,
 * which brought it up to the shipped UI (feature-named gate, accordion nav).
 */
import { test, expect } from "@playwright/test";
import { setTenantCookie, loginAsOperator } from "./helpers/auth";

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const RAW_LITE_SLUG = process.env.PLAYWRIGHT_LITE_TENANT_SLUG ?? "";
const LITE_TENANT_SLUG = RAW_LITE_SLUG
  ? assertTestTenant(RAW_LITE_SLUG, "playwright e2e (lite-plan-gate)")
  : "";
const SKIP_REASON = "PLAYWRIGHT_LITE_TENANT_SLUG not set — needs a dedicated LITE-plan tenant";

/** Gated-nav labels PLAN_GATED_NAV covers (lib/plan-gated-nav.ts) — a LITE tenant with
 *  none of these flags must see none of these entries. Dispatch/Sales Agents are
 *  deliberately excluded: they're gated by separate addon hooks, not plan flags. Returns is
 *  excluded too: catalog v13 gave LITE flag.returns, so a LITE tenant keeps it. */
const GATED_LABELS = [
  "Estimates",
  "Credit Notes",
  "Suppliers",
  "Supplier Bills",
  "Reports",
  "Analytics",
];
/** Always-ungated top-level entries every plan (including LITE) keeps. */
const UNGATED_LABELS = [
  "Dashboard",
  "All Orders",
  // Catalog v13 gave LITE flag.returns (owner 2026-09-28, #2700), so Returns is no longer gated.
  "Returns",
  "Customers",
  "Inventory",
  "Purchase Orders",
  "Products",
];

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
    await expect(nav.getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
    // Gated entries hold a skeleton row while their entitlement query resolves; a count taken
    // before it settles would pass vacuously.
    await expect(nav.locator(".skeleton")).toHaveCount(0);

    // The sidebar is a single-open accordion (layout.tsx SidebarNav): only one group's children
    // are in the DOM at a time. Open each group in turn and collect every link label seen, so the
    // ungated children (All Orders, Inventory ...) and the gated ones are checked against the
    // whole menu rather than whichever group happens to start open.
    const seen = new Set<string>();
    const collect = async () => {
      for (const t of await nav.getByRole("link").allInnerTexts()) seen.add(t.trim());
    };
    await collect();
    const groups = nav.locator("> ul > li > button[aria-expanded]");
    const groupCount = await groups.count();
    for (let i = 0; i < groupCount; i++) {
      const group = groups.nth(i);
      if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
      await expect(group).toHaveAttribute("aria-expanded", "true");
      await collect();
    }

    for (const label of UNGATED_LABELS)
      expect(seen, `${label} should be in the menu`).toContain(label);
    for (const label of GATED_LABELS) expect(seen, `${label} must be hidden`).not.toContain(label);
  });

  test("2. direct navigation to a gated route renders the locked panel, not an error toast", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!LITE_TENANT_SLUG, SKIP_REASON);
    await loginAsLiteOperator(page, context, baseURL);

    await page.goto("/estimates");
    // The gate names the feature (PlanGateBoundary: `${routeLabel} isn't on your plan`, message
    // `${routeLabel} isn't on the ${planName} plan.`); the generic "Not on your plan" is only the
    // PlanGates.tsx fallback when no route label resolves.
    await expect(
      page.getByRole("heading", { name: /^Estimates isn['\u2019]t on your plan$/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /see plans/i })).toBeVisible();
    await expect(page.getByText(/Estimates isn['\u2019]t on the Lite plan\./)).toBeVisible();
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
    // An open group's li also carries its children's text, so keep each row's first line only
    // (the group/link label itself). Poll: gated and regulated entries land after their queries
    // resolve, so a one-shot read right after goto sees a half-built menu. The seeded tenant has a
    // licensed tracked category, hence "Regulated Items".
    const topLevel = page.getByRole("navigation").locator("> ul > li");
    await expect
      .poll(
        async () =>
          (await topLevel.allInnerTexts()).map((t) => t.split("\n")[0].trim()).filter(Boolean),
        { timeout: 15_000 },
      )
      .toEqual([
        "Dashboard",
        "Orders",
        "Dispatch",
        "Customers",
        "Warehouse",
        "Finance",
        "Analytics",
        "Regulated Items",
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
