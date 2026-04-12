import { defineConfig, devices } from "@playwright/test";
import path from "path";

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
 *
 * Auth strategy:
 *   A "setup" project runs first and authenticates each role once, saving
 *   browser storage state to e2e/setup/.auth/*.json. Role-specific projects
 *   depend on "setup" and load that state, so tests start already logged-in
 *   without re-hitting the login endpoint on every beforeEach.
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://app.routeflow.io";

// Path to the pre-authenticated storage state files created by the setup project
const AUTH_DIR = path.join(__dirname, "e2e/setup/.auth");

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/setup/global.setup.ts",
  fullyParallel: false, // sequential within a spec; specs run in parallel
  forbidOnly: !!process.env.CI,
  retries: 2, // Railway can have cold-start latency; always retry twice
  workers: process.env.CI ? 1 : 2,

  timeout: 60_000, // 60 s per test (Railway cold-start latency)
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
    // ── Auth setup ─────────────────────────────────────────────────────────────
    // Runs once before dependent projects; creates per-role storage state files.
    {
      name: "setup",
      testMatch: /setup\/auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },

    // ── Super Admin tests ──────────────────────────────────────────────────────
    {
      name: "super-admin",
      testMatch: /01-super-admin\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "super-admin.json"),
      },
    },

    // ── Operator tests ─────────────────────────────────────────────────────────
    {
      name: "operator",
      testMatch: /02-operator\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Customer tests ─────────────────────────────────────────────────────────
    {
      name: "customer",
      testMatch: /03-customer\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "customer.json"),
      },
    },

    // ── Buyer portal tests ─────────────────────────────────────────────────────
    // No pre-auth needed — buyer tests handle their own auth flows.
    {
      name: "buyer",
      testMatch: /04-buyer-portal\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },

    // ── Cross-cutting tests ────────────────────────────────────────────────────
    // No storageState — each CC test manages its own auth/logout scenarios.
    // They run after all role tests so the throttle window is clear.
    {
      name: "cross-cutting",
      testMatch: /05-cross-cutting\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
