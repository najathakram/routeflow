import { test } from "@playwright/test";
import { CREDENTIALS } from "../helpers/constants";
import { fillWorkspaceIfShown } from "../helpers/auth";

const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

/**
 * P-64 timing harness. REPORT-ONLY: records the time from navigation start to the first data row for four
 * list screens, median of 3 runs, on the `test` tenant after the 5,000-product seed. There is NO expect on
 * time (budgets belong to P-60); the only assertions are that the screen showed a row at all.
 *
 *   node scripts/local-env.mjs --e2e -- "npx playwright test -c scripts/perf/playwright.perf.config.ts"
 *   (PLAYWRIGHT_BASE_URL must be the local web, e.g. http://localhost:3001)
 */
const TENANT = assertTestTenant("test", "perf harness");
const SCREENS = ["/inventory", "/products", "/customers", "/invoices"] as const;
const RUNS = 3;
// A data row: a table body row, or an ARIA row that is not a header row.
const FIRST_ROW = "tbody tr, [role='row']:not(:has([role='columnheader']))";

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test("time to first row on the four list screens", async ({ page }) => {
  await page.goto("/login");
  await fillWorkspaceIfShown(page, TENANT);
  await page.getByLabel("Username or email").fill(CREDENTIALS.operator.username);
  await page.getByPlaceholder("Enter your password").fill(CREDENTIALS.operator.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });

  const report: Record<string, { runsMs: number[]; medianMs: number }> = {};
  for (const screen of SCREENS) {
    const runsMs: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      await page.goto("about:blank");
      const t0 = Date.now();
      await page.goto(screen);
      await page.locator(FIRST_ROW).first().waitFor({ state: "visible", timeout: 120_000 });
      runsMs.push(Date.now() - t0);
    }
    report[screen] = { runsMs, medianMs: median(runsMs) };
    process.stdout.write(
      `PERF ${screen} runs=${runsMs.join(",")}ms median=${report[screen].medianMs}ms\n`,
    );
  }
  process.stdout.write(`PERF-JSON ${JSON.stringify(report)}\n`);
});
