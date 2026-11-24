import { defineConfig, devices } from "@playwright/test";
import { requireBaseUrl } from "../../apps/web/lib/e2e-setup-guard";
import { isLocalUrl } from "../../apps/web/lib/local-url";

/**
 * P-64 timing harness config. Its own file so apps/web/playwright.config.ts stays unchanged.
 * Report-only: the spec records numbers and asserts nothing about time (budgets belong to P-60).
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:3001 \
 *   npx playwright test -c scripts/perf/playwright.perf.config.ts
 *
 * Local only: a non-local base URL is refused here, with no override. Run the 5,000-product seed
 * first (node scripts/perf/seed-catalog-5k.mjs). The tenant is always `test`.
 */
const BASE_URL = requireBaseUrl();
if (!isLocalUrl(BASE_URL)) {
  throw new Error(`The perf harness is local-only; refusing base URL ${BASE_URL}.`);
}

export default defineConfig({
  testDir: "../../apps/web/e2e/perf",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: BASE_URL,
    headless: !process.env.PLAYWRIGHT_HEADED,
    navigationTimeout: 60_000,
    actionTimeout: 30_000,
  },
});
