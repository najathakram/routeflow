/**
 * PKG-8: /dashboard layout shift (CLS < 0.1) with every read delayed 2 s.
 *
 * Visit 1 (undelayed) lets the page record the tenant+user's last-known routes access in
 * localStorage; visit 2 (reload, every dashboard read delayed) is the measured one. Also pins
 * D5: the always-present cards appear, and no empty-state copy shows while data is in flight.
 *
 * Three legs (all read-only, approved test tenants, local stack):
 *  - e2e-routeflow       — routes add-on ON, pre-authenticated operator (the project storageState)
 *  - qa-dashboard-routes — routes add-on ON, fresh login (seeded by apps/api/scripts/e2e-seed.js)
 *  - qa-lite             — NO routes add-on: the Routes/Drivers cards must be absent and nothing shifts
 * The routes legs also assert the Scheduled Routes / Active Drivers stat cards and the Route Runs /
 * Driver Status panels render (a reserved slot must resolve to the real card, never vanish).
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie, fillWorkspaceIfShown } from "./helpers/auth";
import { TENANT_SLUG, LITE_TENANT_SLUG } from "./helpers/constants";
import { waitForDataLoaded } from "./helpers/overflow";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3001";
const DELAYED =
  /\/api\/v1\/(orders|invoices|bookkeeping\/finance-dashboard|route-runs|drivers|products|tenants\/me\/(addons|features)|onboarding|settings)/;
const EMPTY_COPY =
  /No overdue invoices|No runs scheduled|No drivers found|All stock levels healthy/;
const ALWAYS = ["Today's Revenue", "Overdue Invoices", "Active Orders", "Low Stock Items"];

async function installObserver(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
        if (!e.hadRecentInput) w.__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
}

const LEGS = [
  { name: "e2e-routeflow (routes ON)", slug: TENANT_SLUG, login: false, routes: true },
  {
    name: "qa-dashboard-routes (routes ON)",
    slug: "qa-dashboard-routes",
    login: true,
    routes: true,
  },
  { name: "qa-lite (no routes)", slug: LITE_TENANT_SLUG, login: true, routes: false },
] as const;

for (const leg of LEGS) {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    test.describe(`Dashboard CLS @ ${width} - ${leg.name}`, () => {
      if (leg.login) test.use({ storageState: { cookies: [], origins: [] } });
      test.beforeEach(async ({ context }) => {
        await setTenantCookie(context, BASE, leg.slug);
      });

      for (const run of [1, 2]) {
        test(`CLS < 0.1 with delayed reads (run ${run})`, async ({ page }) => {
          await page.setViewportSize({ width, height });
          await installObserver(page);
          if (leg.login) {
            await page.goto("/login");
            await fillWorkspaceIfShown(page, leg.slug);
            await page.getByLabel("Username or email").fill("admin");
            await page.getByPlaceholder("Enter your password").fill("Admin@123");
            await page.getByRole("button", { name: "Sign in", exact: true }).click();
            await page.waitForURL("**/dashboard", { timeout: 30_000 });
          } else {
            await page.goto("/dashboard");
          }
          await waitForDataLoaded(page);

          await page.route(DELAYED, async (route) => {
            await new Promise((r) => setTimeout(r, 2000));
            await route.continue();
          });
          let apiCalls = 0;
          page.on("request", (r) => {
            if (r.url().includes("/api/v1/")) apiCalls++;
          });
          await page.reload();

          // D5: nothing reads as "empty" while loading is still visible.
          for (let i = 0; i < 6; i++) {
            if ((await page.locator(".animate-pulse:visible").count()) === 0) break;
            await expect(page.getByText(EMPTY_COPY)).toHaveCount(0);
            await page.waitForTimeout(250);
          }
          await waitForDataLoaded(page);
          await page.waitForTimeout(1000);

          const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
          // eslint-disable-next-line no-console
          console.log(
            `CLS ${leg.slug} ${width} run${run} = ${cls.toFixed(4)} (api calls ${apiCalls})`,
          );
          expect(cls).toBeLessThan(0.1);
          const stats = page.getByTestId("dashboard-stats");
          for (const label of ALWAYS) await expect(stats.getByText(label)).toBeVisible();
          for (const label of ["Scheduled Routes", "Active Drivers"]) {
            if (leg.routes) await expect(stats.getByText(label)).toBeVisible();
            else await expect(stats.getByText(label)).toHaveCount(0);
          }
          for (const panel of ["Scheduled Route Runs", "Driver Status"]) {
            if (leg.routes) await expect(page.getByText(panel).first()).toBeVisible();
            else await expect(page.getByText(panel)).toHaveCount(0);
          }
        });
      }
    });
  }
}
