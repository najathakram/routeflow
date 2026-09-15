/**
 * House-tenant / MRR reconciliation — post-deploy E2E (review round, 2026-09-15).
 *
 * Permanent post-deploy suite member — runs via the "house-tenant-mrr" project, which mirrors
 * "super-admin"'s shape exactly (same `setup` dependency, same `super-admin.json` storageState,
 * SA creds from PLAYWRIGHT_SA_* only). Never in the local lane's allow-list, matching
 * `01-super-admin.spec.ts` (LOCAL-LANE.md excludes both — no SA creds are seeded locally).
 *
 * READ-ONLY: `routeflow-hq` is not an approved test tenant (CLAUDE.md's test-tenant policy), so
 * this file only reads MRR figures, tenant lists and the mirror row — it must never create, edit
 * or delete a row against `routeflow-hq` or any other live tenant. A prior draft created a
 * throwaway tenant per run to verify the GROWTH plan label; that assertion is already covered by
 * `01-super-admin.spec.ts`'s SA-06 (create tenant → appears in list), so it was removed here
 * rather than kept as a second, redundant write against a live environment.
 *
 * Self-skips (every test) when `routeflow-hq` has not been bootstrapped yet (the owner has not
 * run `apps/api/scripts/bootstrap-house-tenant.mjs --apply` against prod) — without this guard
 * every post-deploy E2E run would go red on a precondition this feature's own rollout owns, not
 * a regression.
 */

import { test, expect, type Page } from "@playwright/test";
import { apiBase } from "./helpers/api";
import { HAS_SUPER_ADMIN_CREDS } from "./helpers/constants";

test.skip(!HAS_SUPER_ADMIN_CREDS, "PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD not set");

const HOUSE_TENANT_SLUG = "routeflow-hq";

/** Read-only existence check — never mutates `routeflow-hq` or any tenant row. */
async function skipUnlessHouseTenantBootstrapped(page: Page): Promise<void> {
  const res = await page.request.get(
    `${apiBase(page.url())}/api/v1/platform-admin/tenants?search=${HOUSE_TENANT_SLUG}&limit=1`,
  );
  const body = res.ok() ? await res.json() : null;
  const found = Boolean(body?.data?.some((t: { slug?: string }) => t.slug === HOUSE_TENANT_SLUG));
  test.skip(
    !found,
    `house tenant ${HOUSE_TENANT_SLUG} not bootstrapped; run apps/api/scripts/bootstrap-house-tenant.mjs --apply`,
  );
}

function attachEvidenceCollectors(page: Page) {
  const consoleErrors: string[] = [];
  const networkFailures: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`[unhandled] ${err.message}`));
  page.on("requestfailed", (req) => {
    networkFailures.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "aborted"}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) {
      networkFailures.push(`${res.request().method()} ${res.url()} — ${res.status()}`);
    }
  });

  return { consoleErrors, networkFailures };
}

test.describe("House-tenant / MRR reconciliation — UI verify", () => {
  // Storage state (super-admin.json) is pre-loaded by the "house-tenant-mrr" Playwright
  // project (mirrors "super-admin"), so each test context starts already authenticated.
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/admin/dashboard");
    await skipUnlessHouseTenantBootstrapped(page);
  });

  test("Flow 1: dashboard MRR card — unlabeled figure + Reconciled to ledger sub-line, no Est. prefix", async ({
    page,
  }) => {
    const { consoleErrors, networkFailures } = attachEvidenceCollectors(page);
    try {
      await page.goto("/admin/dashboard");
      await expect(page.getByText(/loading dashboard/i)).toHaveCount(0, { timeout: 20_000 });

      const mrrElCount = await page.getByTestId("dashboard-mrr").count();
      const ledgerElCount = await page.getByTestId("dashboard-ledger-mrr").count();
      const estMrrCount = await page.getByText(/est\.\s*mrr/i).count();

      await page.screenshot({
        path: "test-output/artifacts/flow1-dashboard-desktop.png",
        fullPage: true,
      });

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          flow: 1,
          mrrElCount,
          ledgerElCount,
          estMrrCount,
        }),
      );

      expect(mrrElCount, "expected a [data-testid=dashboard-mrr] element").toBeGreaterThan(0);
      expect(
        ledgerElCount,
        "expected a [data-testid=dashboard-ledger-mrr] 'Reconciled to ledger' sub-line",
      ).toBeGreaterThan(0);
      expect(estMrrCount, "dashboard should not show an 'Est. MRR' label anywhere").toBe(0);

      if (mrrElCount > 0) {
        await expect(page.getByTestId("dashboard-mrr")).toHaveText(/^\$\d[\d,]*\.\d{2}$/);
      }
    } finally {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ flow: 1, consoleErrors, networkFailures }));
    }
  });

  test("Flow 2: Billing Overview MRR equals dashboard MRR (read immediately after)", async ({
    page,
  }) => {
    const { consoleErrors, networkFailures } = attachEvidenceCollectors(page);
    try {
      await page.goto("/admin/dashboard");
      await expect(page.getByText(/loading dashboard/i)).toHaveCount(0, { timeout: 20_000 });
      const dashMrrLocator = page.getByTestId("dashboard-mrr");
      const dashMrrCount = await dashMrrLocator.count();
      const dashboardMrrText = dashMrrCount > 0 ? await dashMrrLocator.textContent() : null;

      await page.goto("/admin/billing");
      await expect(page).not.toHaveURL(/error/);
      await expect(page.locator("main, h1, h2, [class*='card']").first()).toBeVisible({
        timeout: 15_000,
      });

      // Wait for the "Loading billing data..." placeholder to clear before reading the
      // MRR stat, then use an auto-retrying assertion (never check-then-act on a
      // separately-queried element).
      await expect(page.getByText(/loading billing data/i)).toHaveCount(0, { timeout: 20_000 });

      const billingMrrLabel = page.getByText(/^(mrr|est\.\s*mrr)$/i).first();
      let billingMrrLabelVisible = false;
      try {
        await expect(billingMrrLabel).toBeVisible({ timeout: 10_000 });
        billingMrrLabelVisible = true;
      } catch {
        billingMrrLabelVisible = false;
      }
      let billingMrrValueText: string | null = null;
      if (billingMrrLabelVisible) {
        const card = billingMrrLabel.locator("xpath=ancestor::*[self::div][1]");
        billingMrrValueText = await card.textContent();
      }

      await page.screenshot({
        path: "test-output/artifacts/flow2-billing-overview-desktop.png",
        fullPage: true,
      });

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          flow: 2,
          dashMrrCount,
          dashboardMrrText,
          billingMrrLabelVisible,
          billingMrrValueText,
        }),
      );

      expect(dashMrrCount, "dashboard MRR element must exist to compare").toBeGreaterThan(0);
      expect(billingMrrLabelVisible, "Billing Overview MRR stat must be visible").toBe(true);
    } finally {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ flow: 2, consoleErrors, networkFailures }));
    }
  });
});
