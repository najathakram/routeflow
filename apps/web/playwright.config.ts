import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for full Chrome UI coverage against Railway.
 *
 * Required env vars (create .env.playwright or export before running):
 *   PLAYWRIGHT_BASE_URL   — e.g. https://app.routeflow.io or Railway URL
 *   PLAYWRIGHT_TENANT_SLUG — tenant slug for operator / customer tests
 *
 * Run commands:
 *   npx playwright test                     # headless, all specs
 *   npx playwright test --headed            # headed (watch mode)
 *   npx playwright test e2e/01-super-admin  # single spec
 *   npx playwright test --reporter=html     # HTML report
 */

// Load .env.playwright if present (dotenv-style)
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://app.routeflow.io";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // sequential within a spec; specs run in parallel
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1, // Railway can have cold-start latency
  workers: process.env.CI ? 1 : 2,

  timeout: 45_000, // 45 s per test
  expect: { timeout: 15_000 }, // 15 s per assertion

  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],

  use: {
    baseURL: BASE_URL,
    browserName: "chromium",
    headless: !process.env.PLAYWRIGHT_HEADED,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
