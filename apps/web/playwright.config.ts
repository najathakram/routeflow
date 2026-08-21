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

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

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

  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],

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

    // ── Auth & password flows ──────────────────────────────────────────────────
    // No project-level storageState — most of these tests exercise login,
    // forgot-password and reset states, so they manage their own auth. The
    // session-expiry / settings-password block inside the spec opts into the
    // operator state via test.use(), so it needs "setup" to have run first.
    {
      name: "auth-password",
      testMatch: /07-auth-password\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },

    // ── Critical-path regression tests ────────────────────────────────────────
    // Money-math and core integrity checks — run after every deploy.
    // Uses operator auth state; no mutations (safe against production data).
    {
      name: "critical-paths",
      testMatch: /06-critical-paths\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Create-order Escape scoping (WP-1) ────────────────────────────────────
    // Uses operator auth state; exercises the order-builder Escape/draft flow.
    // The spec shipped without this project entry, so it NEVER ran.
    {
      name: "create-order-escape",
      testMatch: /08-create-order-escape\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Regulated compliance smoke ─────────────────────────────────────────────
    // Report-panel UX on /compliance/[categoryId] with every regulated endpoint
    // mocked — no mutations reach any tenant. Self-skips on web builds that
    // predate the report-panel UX, so it is safe to run before the deploy.
    {
      name: "regulated-compliance",
      testMatch: /09-regulated-compliance\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Product demand card ────────────────────────────────────────────────────
    // Sales Demand chart on /products/[id]; every endpoint mocked, so it reaches
    // the never-sold and empty-window states live data cannot. Self-skips on web
    // builds that predate the card.
    {
      name: "product-demand",
      testMatch: /11-product-demand\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Search survives Back ───────────────────────────────────────────────────
    // Back-navigation restoration of a list search — the one behavior no other spec
    // covers (nothing else in the suite calls goBack). Read-only: it types in search
    // boxes and navigates, and mutates nothing. Self-skips on builds predating the
    // URL-backed search.
    {
      name: "search-back-nav",
      testMatch: /12-search-back-nav\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Boxed order entry (WP2-13) ─────────────────────────────────────────────
    // Cases/pieces proration read live off the order builder UI. Read-only: it
    // never places the order — it Escapes out, which auto-parks a draft the
    // spec's own afterEach deletes. Uses operator auth state.
    {
      name: "boxed-order-entry",
      testMatch: /13-boxed-order-entry\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Pack-size prompt (WP2-14) ──────────────────────────────────────────────
    // Product-create modal's parser refusal contract (HIGH pre-fills,
    // AMBIGUOUS refuses empty, PIECE_UNIT renders nothing). Read-only: never
    // saves — the modal is always closed by hand, "Create Product" never clicked.
    {
      name: "pack-size-prompt",
      testMatch: /14-pack-size-prompt\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Stock-count UI (WP3-15) ────────────────────────────────────────────────
    // Inventory → Stock Count tab session lifecycle. Discard-only: never
    // commits a session, so zero stock impact by construction.
    {
      name: "stock-count-ui",
      testMatch: /15-stock-count-ui\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Variant-split UI (WP3-16) ──────────────────────────────────────────────
    // "Assign to variants" modal on a parent product. Cancel-only: never
    // applies the split.
    {
      name: "variant-split-ui",
      testMatch: /16-variant-split-ui\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Buyer shop density + product detail (WP3-17) ───────────────────────────
    // No pre-auth needed — self-contained register→invite→accept dance, same as
    // the "buyer" project. A spec without its own project entry never runs.
    {
      name: "buyer-shop",
      testMatch: /17-buyer-shop-density-detail\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
