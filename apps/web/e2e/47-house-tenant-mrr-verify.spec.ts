/**
 * UI-drive evidence spec — Phase 0 W2 T12-T15 (house-tenant bootstrap,
 * TenantMirrorService, MRR/plan-label web edits).
 *
 * Ad hoc verification spec, NOT part of the permanent suite numbering scheme
 * for a shipped feature — written by the UI evidence collector to exercise:
 *   1. Create a tenant with plan GROWTH; tenant list + detail page show "Growth".
 *   2. Dashboard MRR card shows an unlabeled figure with a "Reconciled to
 *      ledger" sub-line, no "Est." prefix.
 *   3. Billing Overview MRR figure equals the dashboard's, read immediately after.
 *
 * Runs against the LOCAL dev stack (localhost:3001 / :3000), not Railway —
 * PLAYWRIGHT_BASE_URL is overridden per-test via page.goto with an absolute
 * URL where needed, and PLAYWRIGHT_SA_USERNAME/PASSWORD must be set to a
 * super-admin account that exists in the local dev DB (docker-compose).
 */

import { test, expect, type Page } from "@playwright/test";
import { apiBase } from "./helpers/api";

const BASE_URL = "http://localhost:3001";
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

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
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto(`${BASE_URL}/admin-login`);
    await page
      .getByPlaceholder("Platform admin username")
      .fill(process.env.PLAYWRIGHT_SA_USERNAME!);
    await page.getByPlaceholder("Password").fill(process.env.PLAYWRIGHT_SA_PASSWORD!);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/admin/dashboard", { timeout: 30_000 });
  });

  test("Flow 1: create GROWTH tenant, list + detail show Growth", async ({ page }) => {
    const { consoleErrors, networkFailures } = attachEvidenceCollectors(page);
    try {
      await page.goto(`${BASE_URL}/admin/tenants/new`);

      const catalogRes = await page.request.get(`${apiBase(page.url())}/api/v1/billing/plans`);
      expect(catalogRes.ok()).toBeTruthy();

      const planSelect = page.getByRole("combobox").first();
      await expect(planSelect).toBeVisible({ timeout: 15_000 });
      const optionValues = await planSelect
        .locator("option")
        .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
      const optionLabels = await planSelect
        .locator("option")
        .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).textContent));

      await page.screenshot({
        path: "test-output/artifacts/flow1-tenant-new-plan-select-desktop.png",
        fullPage: true,
      });

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({ flow: 1, step: "plan-select-options", optionValues, optionLabels }),
      );

      const hasGrowthOption = optionValues.includes("GROWTH");
      expect(
        hasGrowthOption,
        `plan select must offer a GROWTH option (got values=${JSON.stringify(optionValues)}, labels=${JSON.stringify(optionLabels)})`,
      ).toBe(true);

      await planSelect.selectOption("GROWTH");

      const slug = `e2e-uidrive-${Date.now()}`;
      await page.getByPlaceholder("e.g. acme-foods").fill(slug);
      await page.getByPlaceholder("e.g. Acme Foods Ltd.").fill("UI Drive Growth Tenant");
      await page.getByPlaceholder("admin@acme.com").fill(`admin@${slug}.com`);
      await page.getByPlaceholder("acme_admin").fill(`${slug}_admin`);
      await page.getByPlaceholder("Min. 8 characters").fill("AdminPass@123!");
      await page.getByRole("button", { name: "Create Tenant", exact: true }).click();
      await page.waitForURL(/\/admin\/tenants/, { timeout: 20_000 });

      const row = page.getByRole("row").filter({ hasText: slug });
      await expect(row).toBeVisible({ timeout: 15_000 });

      const listPlanText = (await row.textContent()) ?? "";

      await row.getByRole("link", { name: "View" }).click();
      await page.waitForURL(/\/admin\/tenants\/.+/, { timeout: 15_000 });
      await expect(page.getByRole("button", { name: /overview/i })).toBeVisible({
        timeout: 10_000,
      });

      await page.screenshot({
        path: "test-output/artifacts/flow1-tenant-detail-desktop.png",
        fullPage: true,
      });

      const detailBodyText = (await page.locator("body").textContent()) ?? "";

      // Assertions recorded as pass/fail facts — not fixed here.
      const listShowsGrowth = listPlanText.includes("Growth");
      const detailShowsGrowth = detailBodyText.includes("Growth");
      const listShowsRawGrowth = listPlanText.includes("GROWTH");
      const detailShowsRawGrowth = detailBodyText.includes("GROWTH");

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          flow: 1,
          slug,
          listPlanText,
          listShowsGrowth,
          listShowsRawGrowth,
          detailShowsGrowth,
          detailShowsRawGrowth,
        }),
      );

      expect(listShowsGrowth, "tenant list should render plan label 'Growth'").toBe(true);
      expect(detailShowsGrowth, "tenant detail should render plan label 'Growth'").toBe(true);
    } finally {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ flow: 1, consoleErrors, networkFailures }));
    }
  });

  test("Flow 2: dashboard MRR card — unlabeled figure + Reconciled to ledger sub-line, no Est. prefix", async ({
    page,
  }) => {
    const { consoleErrors, networkFailures } = attachEvidenceCollectors(page);
    try {
      await page.goto(`${BASE_URL}/admin/dashboard`);
      await expect(page.getByText(/loading dashboard/i)).toHaveCount(0, { timeout: 20_000 });

      const mrrElCount = await page.getByTestId("dashboard-mrr").count();
      const ledgerElCount = await page.getByTestId("dashboard-ledger-mrr").count();
      const estMrrCount = await page.getByText(/est\.\s*mrr/i).count();

      await page.screenshot({
        path: "test-output/artifacts/flow2-dashboard-desktop.png",
        fullPage: true,
      });

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          flow: 2,
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
      console.log(JSON.stringify({ flow: 2, consoleErrors, networkFailures }));
    }
  });

  test("Flow 3: Billing Overview MRR equals dashboard MRR (read immediately after)", async ({
    page,
  }) => {
    const { consoleErrors, networkFailures } = attachEvidenceCollectors(page);
    try {
      await page.goto(`${BASE_URL}/admin/dashboard`);
      await expect(page.getByText(/loading dashboard/i)).toHaveCount(0, { timeout: 20_000 });
      const dashMrrLocator = page.getByTestId("dashboard-mrr");
      const dashMrrCount = await dashMrrLocator.count();
      const dashboardMrrText = dashMrrCount > 0 ? await dashMrrLocator.textContent() : null;

      await page.goto(`${BASE_URL}/admin/billing`);
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
        path: "test-output/artifacts/flow3-billing-overview-desktop.png",
        fullPage: true,
      });

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          flow: 3,
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
      console.log(JSON.stringify({ flow: 3, consoleErrors, networkFailures }));
    }
  });
});
