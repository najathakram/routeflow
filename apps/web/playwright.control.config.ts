import { defineConfig, devices } from "@playwright/test";

/**
 * Standalone config for the RouteFlow Control command-center verification (UI1 / T30).
 * Targets the control server only (no web app, no webServer): start it first with
 *   CONTROL_LOCAL=1 CONTROL_FIXTURE=apps/control/test/fixtures/acme CONTROL_PORT=4317 node apps/control/dist/main.js
 * Run from the repo root: npx playwright test -c apps/web/playwright.control.config.ts
 */
export default defineConfig({
  testDir: "./e2e/control",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4317",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
