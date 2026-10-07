/**
 * PKG-8: /dashboard layout shift (CLS < 0.1) with every read delayed 2 s.
 *
 * Visit 1 (undelayed) lets the page record the tenant+user's last-known routes access in
 * localStorage; visit 2 (reload, every dashboard read delayed) is the measured one. Also pins
 * D5: the always-present cards appear, and no empty-state copy shows while data is in flight.
 *
 * Role: OPERATOR (pre-authenticated). Tenant: approved e2e-routeflow seed. Read-only.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
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

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  test.describe(`Dashboard CLS @ ${width}`, () => {
    test.beforeEach(async ({ context }) => {
      await setTenantCookie(context, BASE);
    });

    for (const run of [1, 2]) {
      test(`CLS < 0.1 with delayed reads (run ${run})`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await installObserver(page);
        await page.goto("/dashboard");
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
        console.log(`CLS ${width} run${run} = ${cls.toFixed(4)} (api calls ${apiCalls})`);
        expect(cls).toBeLessThan(0.1);
        for (const label of ALWAYS) {
          await expect(page.getByTestId("dashboard-stats").getByText(label)).toBeVisible();
        }
      });
    }
  });
}
