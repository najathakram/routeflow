/**
 * F18 — B58: plan-change guard + routing (R-B58, T2/T4 in bug-test-plan.md).
 *
 * REG-B58 (web leg): `/choose-plan`'s "Choose" control always ends in
 * `commit()` posting `POST /billing/subscribe` — the fresh-subscribe
 * endpoint — no matter whether the tenant already holds an ACTIVE
 * subscription. The server's `planChangePreview` (T2, jest-proven in
 * apps/api/src/billing/subscription-mutation.service.spec.ts) classifies an
 * in-place plan swap as UPGRADE or DOWNGRADE; `/billing/quote` carries that
 * classification on `change` (T3, settings-billing.controller.spec.ts). This
 * spec proves the CLIENT half: the chooser must read `quote.change.action`
 * and route to `POST /billing/subscription` (upgrade) or
 * `POST /billing/subscription/downgrade` (downgrade) instead of always
 * calling `POST /billing/subscribe`.
 *
 * FULLY MOCKED — NO WRITES: `/billing/plans`, `/billing/recommendation`,
 * `/billing/quote`, `/billing/subscription`, `/billing/subscribe`,
 * `/billing/subscription/downgrade` and (case 3) `/tenants/me/addons` are all
 * intercepted with `page.route` before the page is opened, following
 * 26-import-duplicates.spec.ts's technique. The three mutation handlers only
 * intercept POSTs (see mockMutations) — a GET of the same path is a read and
 * passes through. Nothing on any tenant is created, upgraded, downgraded, or
 * cancelled.
 *
 * Fails TODAY: `commit()` unconditionally posts `/billing/subscribe`, so for
 * both the UPGRADE and DOWNGRADE quotes below `subscribeHits()` reads 1 where
 * the assertion expects 0, and the summary card's button never reads
 * "Upgrade to …" / "Schedule downgrade" — it reads "Subscribe to …".
 *
 * WITHOUT the `change-plan-routing` project entry in playwright.config.ts
 * this spec NEVER RUNS — see 08-create-order-escape's header for the
 * precedent where exactly that happened and a spec sat dead for a release.
 *
 * Role: OPERATOR (storage state from the "change-plan-routing" project, same
 * as 18/19/20). Runs against the DEPLOYED build — T2 in the build plan is
 * proven-pending-deploy, T4 is this spec's own row. NOT part of F18's local
 * red gate: the routing branch itself is unit-tested pre-deploy in
 * `apps/web/lib/api/billing.test.ts` (every `dispatchPlanChange` action); this
 * Playwright project proves the PAGE WIRING — that the chooser reads
 * `quote.change.action` and commits through that dispatch — post-deploy.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { apiBase, operatorAccessToken } from "./helpers/api";

// ─── Canned catalog / recommendation bodies ──────────────────────────────────

const PLANS_BODY = {
  version: 1,
  effectiveAt: null,
  plans: [
    {
      planKey: "STARTER",
      name: "Starter",
      monthlyPrice: 49,
      annualPrice: 490,
      isCustom: false,
      seatsIncluded: 3,
      routesConcurrent: 2,
      scansIncluded: 50,
      msgsIncluded: 100,
      featureFlags: [],
      sortOrder: 1,
    },
    {
      planKey: "BUSINESS",
      name: "Business",
      monthlyPrice: 199,
      annualPrice: 1990,
      isCustom: false,
      seatsIncluded: 10,
      routesConcurrent: 8,
      scansIncluded: 500,
      msgsIncluded: 1000,
      featureFlags: [],
      sortOrder: 2,
    },
    {
      planKey: "ENTERPRISE",
      name: "Enterprise",
      monthlyPrice: null,
      annualPrice: null,
      isCustom: true,
      seatsIncluded: null,
      routesConcurrent: null,
      scansIncluded: null,
      msgsIncluded: 0,
      featureFlags: [],
      sortOrder: 3,
    },
  ],
};

const RECOMMENDATION_BODY = {
  currentPlanKey: "STARTER",
  usage: { seats: 1, routes: 1, scans: 1, msgs: 1 },
  perPlan: [],
  recommendedPlanKey: "BUSINESS",
  preCheckedAddons: [],
};

const RENEWAL_AT = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

function quoteBody(action: "UPGRADE" | "DOWNGRADE", planKey: string, planName: string) {
  return {
    planKey,
    planName,
    cycle: "MONTHLY",
    isCustom: false,
    lines: [
      {
        type: "plan",
        key: planKey,
        name: planName,
        quantity: 1,
        monthly: 199,
        cyclePrice: 199,
        included: false,
      },
    ],
    subtotalMonthly: 199,
    dueToday: action === "UPGRADE" ? 123.45 : 0,
    annualSaving: 0,
    renewalAt: RENEWAL_AT,
    // seatAckRequired is REQUIRED on the web mirror (round 4): the chooser gates its
    // deactivation acknowledgement on this boolean alone, never on `warning` text.
    change:
      action === "UPGRADE"
        ? {
            action: "UPGRADE",
            proratedNow: 123.45,
            keepsRenewalAt: RENEWAL_AT,
            seatAckRequired: false,
          }
        : {
            action: "DOWNGRADE",
            effectiveAt: RENEWAL_AT,
            proratedNow: null,
            seatAckRequired: false,
          },
  };
}

/**
 * Registers the three mutation routes and returns per-route hit counters (plus
 * the downgrade request body).
 *
 * Every handler counts POSTs ONLY. On success `commit()` navigates to
 * `/settings/billing` (choose-plan/page.tsx), whose `useSubscription()` GETs
 * `/billing/subscription` — the same URL the upgrade mutation posts to, and
 * page.route survives the navigation. Counting that read would push
 * `hits.upgrade` past 1 in the UPGRADE tests and off 0 in the DOWNGRADE one,
 * turning a correct implementation red. Non-POSTs are passed through untouched
 * (they are reads).
 */
async function mockMutations(page: Page) {
  const hits: {
    subscribe: number;
    upgrade: number;
    downgrade: number;
    downgradeBody?: unknown;
  } = { subscribe: 0, upgrade: 0, downgrade: 0 };
  await page.route(/\/billing\/subscribe(\?.*)?$/, (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    hits.subscribe += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route(/\/billing\/subscription\/downgrade(\?.*)?$/, (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    hits.downgrade += 1;
    hits.downgradeBody = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  // MUST be registered after the downgrade route: both patterns match on the
  // same suffix (`/billing/subscription...`), and page.route dispatches to
  // the LAST-registered matching handler first.
  await page.route(/\/billing\/subscription(\?.*)?$/, (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    hits.upgrade += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  return hits;
}

async function mockCatalog(page: Page) {
  await page.route(/\/billing\/plans(\?.*)?$/, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PLANS_BODY),
    }),
  );
  await page.route(/\/billing\/recommendation(\?.*)?$/, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(RECOMMENDATION_BODY),
    }),
  );
}

/** Confirms the pre-authenticated operator session actually resolves before spending the test. */
async function requireOperatorSession(page: Page) {
  await page.goto("/dashboard");
  const token = await operatorAccessToken(page);
  // Hard assertions, never test.skip(): a broken auth state must report RED, not green-by-skip
  // (a skipped test is the same silent-pass shape a missing playwright.config entry produces).
  expect(token, "no operator token — auth setup did not run").toBeTruthy();
  const res = await page.request.get(`${apiBase(page.url())}/api/v1/tenants/me/addons`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `session token did not authenticate (${res.status()})`).toBe(true);
}

test.describe("Choose-plan routing (F18 / B58)", () => {
  test("REG-B58 an UPGRADE quote is committed via POST /billing/subscription, never /billing/subscribe (T2/T4)", async ({
    page,
  }) => {
    await requireOperatorSession(page);
    await mockCatalog(page);
    const hits = await mockMutations(page);
    await page.route(/\/billing\/quote(\?.*)?$/, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(quoteBody("UPGRADE", "BUSINESS", "Business")),
      }),
    );

    await page.goto("/choose-plan");
    // The first non-custom plan's Choose control (Enterprise renders "Contact
    // sales" instead — excluded by construction).
    const chooseButtons = page.getByRole("button", { name: "Choose" });
    await expect(chooseButtons.first()).toBeVisible({ timeout: 15_000 });
    await chooseButtons.first().click();

    // Summary card renders the mocked $123.45 due-today figure.
    const summary = page.getByText("Due today").locator("..");
    await expect(summary).toContainText("$123.45");

    // T4: the commit control must read as an upgrade, not a fresh subscribe.
    const commitButton = page.getByRole("button", { name: /Upgrade to/i });
    await expect(commitButton).toBeVisible();
    await commitButton.click();

    await expect.poll(() => hits.upgrade).toBe(1);
    expect(hits.subscribe).toBe(0);
    expect(hits.downgrade).toBe(0);
  });

  test("REG-B58 a DOWNGRADE quote is committed via POST /billing/subscription/downgrade, never /billing/subscribe (T2/T4)", async ({
    page,
  }) => {
    await requireOperatorSession(page);
    await mockCatalog(page);
    const hits = await mockMutations(page);
    await page.route(/\/billing\/quote(\?.*)?$/, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(quoteBody("DOWNGRADE", "STARTER", "Starter")),
      }),
    );

    await page.goto("/choose-plan");
    const chooseButtons = page.getByRole("button", { name: "Choose" });
    await expect(chooseButtons.first()).toBeVisible({ timeout: 15_000 });
    await chooseButtons.first().click();

    const commitButton = page.getByRole("button", { name: /Schedule downgrade/i });
    await expect(commitButton).toBeVisible();
    await commitButton.click();

    await expect.poll(() => hits.downgrade).toBe(1);
    // The exact payload matters, not just the URL: an empty `retainedUserIds`
    // is the deliberate contract (server default too — settings-billing.controller.ts),
    // meaning "keep only admins" if the tenant ends up over the new seat cap. The
    // seat warning + its acknowledgement gate live server-side / on the page, not here.
    expect(hits.downgradeBody).toEqual({ targetPlanKey: "STARTER", retainedUserIds: [] });
    expect(hits.subscribe).toBe(0);
    expect(hits.upgrade).toBe(0);
  });

  test("REG-B58 the PlanGates upsell CTA lands on a chooser that still routes UPGRADE (Amendment 2, T4)", async ({
    page,
  }) => {
    await requireOperatorSession(page);
    // Deterministically force the sales-agents page into its LockedPage
    // branch (apps/web/app/(dashboard)/sales-agents/page.tsx) regardless of
    // the live tenant's addon state.
    await page.route(/\/tenants\/me\/addons(\?.*)?$/, (route: Route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"addons":[]}' }),
    );
    await mockCatalog(page);
    const hits = await mockMutations(page);
    await page.route(/\/billing\/quote(\?.*)?$/, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(quoteBody("UPGRADE", "BUSINESS", "Business")),
      }),
    );

    await page.goto("/sales-agents");
    await expect(page.getByText(/isn't enabled for this workspace/i)).toBeVisible({
      timeout: 15_000,
    });

    // LockedPage's CTA is an <a href="/choose-plan"> wrapping a Button — with
    // no `gate.upgrade` payload here it renders "See plans".
    await page
      .getByRole("link")
      .filter({ hasText: /See plans/i })
      .click();
    await page.waitForURL("**/choose-plan");

    const chooseButtons = page.getByRole("button", { name: "Choose" });
    await expect(chooseButtons.first()).toBeVisible({ timeout: 15_000 });
    await chooseButtons.first().click();

    const commitButton = page.getByRole("button", { name: /Upgrade to/i });
    await expect(commitButton).toBeVisible();
    await commitButton.click();

    await expect.poll(() => hits.upgrade).toBe(1);
    expect(hits.subscribe).toBe(0);
  });
});
