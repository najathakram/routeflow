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

  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    // Machine-readable results for scripts/campaign-check.mjs (the bug-register
    // campaign's gate reads passed/skipped per REG-B### title). Path is relative
    // to this config file; .campaign/runs/ at the repo root is gitignored.
    ["json", { outputFile: "../../.campaign/runs/web-e2e.json" }],
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

    // ── Sales-agents entitlement gate (PR-D 18) ────────────────────────────────
    // Reads the tenant's live addon flag and asserts the nav entry / locked card
    // match it. Read-only: GETs and renders only — nothing is created or approved.
    // Uses operator auth state; the spec reads its token out of that session.
    {
      name: "sales-agents-gate",
      testMatch: /18-sales-agents-gate\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Compliance-pack entitlement gate (tobacco consolidation, 19) ──────────
    // Reads the tenant's live addon flag and asserts the /tobacco redirect and
    // the hub's locked/unlocked state match it. Read-only: GETs and renders only.
    {
      name: "compliance-pack-gate",
      testMatch: /19-compliance-pack-gate\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },
    // ── Ad-hoc trip builder entitlement gate (WP12, spec 20) ────────────────────────
    // Reads the tenant's live order_delivery addon flag and asserts the orders
    // bulkbar action / trip-builder deep-link match it. Read-only: GETs and
    // renders only — Build/Create trip/Send are never clicked.
    // Uses operator auth state; the spec reads its token out of that session.
    {
      name: "trip-builder-gate",
      testMatch: /20-trip-builder-gate\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: path.join(AUTH_DIR, "operator.json") },
    },

    // ── Destructive-write guards (F02b, spec 21) ───────────────────────────────
    // REG-B24 / REG-B130 / REG-B154: products + customers bulk-delete confirm
    // dialogs, the guarded-product skip report, the customer soft-delete branch,
    // and the products selection reset. Mutating but self-contained: it creates
    // its own `E2E B2x …` throwaway product/customer fixtures on the approved
    // seed tenant and never destroys a discovered record — the guarded product
    // it selects is the one bulkDelete must SKIP.
    // Uses operator auth state; the spec reads its token out of that session.
    {
      name: "destructive-guards",
      testMatch: /21-destructive-guards\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: path.join(AUTH_DIR, "operator.json") },
    },

    // ── Payment-status truth (F03, spec 22) ────────────────────────────────────
    // REG-B11: a DRAFT (unconfirmed) InvoicePayment must be VISIBLE on the
    // invoice payment-history row with a "Draft - unconfirmed" badge, while
    // being excluded from every money SUM (balanceDue, dashboards, documents).
    // The server half is T1-proven in apps/api; this spec is the T2 leg and
    // proves the badge against the DEPLOYED build.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS - see 08-create-order-escape's
    // header for the precedent where exactly that happened and a spec sat dead.
    {
      name: "payment-truth",
      testMatch: /22-payment-truth\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: path.join(AUTH_DIR, "operator.json") },
    },

    // ── Run-settlement visibility (F05, spec 23) ───────────────────────────────
    // REG-B167: a COMPLETED run's detail page must surface its settlementNote,
    // the SIGNED settlementVariance, and the legacy run.notes a pre-F05 mobile
    // build wrote its settlement text to — cash discrepancies currently close
    // invisibly. The server half (settlement endpoint, cash truth, the
    // close-unsettled backstops) is T1-proven in apps/api; this spec is the T2
    // leg and proves the read surface against the DEPLOYED build.
    // Mutating but self-contained: it creates its own stopless `E2E B167 …`
    // route + run, settles and closes THAT run, and touches nothing it did not
    // create. No at-door collection, so no driver_payments addon is needed.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS - see 08-create-order-escape's
    // header for the precedent where exactly that happened and a spec sat dead.
    {
      name: "run-settlement",
      testMatch: /23-run-settlement-note\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: path.join(AUTH_DIR, "operator.json") },
    },

    // ── Migration hub connector gate (F17, spec 25) ────────────────────────────
    // REG-B08: Start migration must be disabled and relabelled "Connector coming
    // soon" for sources with connected: false (Zoho Books, QuickBooks), and stay
    // enabled for CSV. Read-only: Start is never clicked, so no job is created.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS - see 22-payment-truth's precedent.
    {
      name: "migration-hub-gate",
      testMatch: /25-migration-hub\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: path.join(AUTH_DIR, "operator.json") },
    },

    // ── Payments-import duplicate reporting (F17, spec 26) ─────────────────────
    // REG-B99 web leg: /settings/import must surface importPayments' new
    // `duplicates` count in the success toast summary and the Customer Payments
    // card's result badge (the server half is jest-proven in apps/api).
    // Fully mocked: POST /import/payments is intercepted, so no CSV is ever
    // uploaded and nothing on the tenant is written.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS - see 22-payment-truth's precedent.
    {
      name: "import-duplicates",
      testMatch: /26-import-duplicates\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: path.join(AUTH_DIR, "operator.json") },
    },

    // ── Order-edit pricing readiness gate (F06, spec 24) ───────────────────────
    // REG-B62: the order-edit page's add-product and substitute controls must
    // stay disabled (with a "Loading customer pricing…" hint) until the
    // customer detail + customer-price queries settle, so a line can never be
    // added or substituted at a transient list price before the customer's
    // contracted tier loads. Makes the race deterministic via `page.route`
    // holding GET /customers/:id rather than racing real network timing.
    // Mutating but self-contained: creates its own throwaway `E2E B62 …`
    // customer + two products + a DRAFT order on the approved seed tenant and
    // deletes nothing (same tolerance 21-destructive-guards/22-payment-truth's
    // own throwaway fixtures take). NOT part of F06's red gate — this spec
    // proves a client-side query race with no web unit runner behind it
    // (campaign decision D1), so it runs only against the DEPLOYED site and is
    // expected red until F06 ships.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's
    // header for the precedent where exactly that happened and a spec sat dead.
    {
      name: "order-edit-pricing",
      testMatch: /24-order-edit-pricing\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: path.join(AUTH_DIR, "operator.json") },
    },

    // ── B465 fix round 2: SPECIAL-tier reason required (spec 48) ─────────────
    // Same posture as order-edit-pricing above — a client-side requirement
    // with no web unit runner behind it, so this runs only against a live app
    // instance (deploy-triggered or `local:e2e`), self-provisions its own
    // customer/product/order fixtures, and deletes nothing.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's
    // header for the precedent where exactly that happened and a spec sat dead.
    {
      name: "special-tier-reason-required",
      testMatch: /48-special-tier-reason-required\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: path.join(AUTH_DIR, "operator.json") },
    },

    // ── Cancelled-order "editing closed" banner (F07, spec 27) ────────────────
    // REG-B10: the operator order-detail page must explain WHY the edit window
    // is closed on a CANCELLED order ("Order cancelled — editing closed")
    // instead of silently dropping the Edit Items button. The server already
    // emits editWindow.closedReason "STATUS"; only the page's render condition
    // is wrong, so this has no jest half — it is R17's ONLY proof.
    // Mutating but self-contained: it creates its own throwaway `E2E B10 …`
    // customer + product + PENDING order on the approved seed tenant and
    // API-deletes the order in a `finally`, pass or fail. NOT part of F07's red
    // gate — it runs only against the DEPLOYED site and is expected red until
    // F07 ships.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's
    // header for the precedent where exactly that happened and a spec sat dead.
    {
      name: "cancelled-edit-banner",
      testMatch: /27-cancelled-edit-banner\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: path.join(AUTH_DIR, "operator.json") },
    },

    // ── Recurring-template edit + standing-order item edit (F13, spec 30) ──────
    // REG-B92: /invoices/recurring/[id]/edit exists and persists a schedule/notes
    // change; every list card links to it. REG-B09: the Edit Standing Order modal
    // persists item adds and qty changes through PATCH `items`. REG-B106 web leg:
    // after Run Now the card shows the recorded "Succeeded" outcome (the API write
    // is jest-proven in apps/api). Mutating but self-contained: throwaway
    // `E2E B09 …` / `E2E B92 …` fixtures on the approved seed tenant; the recurring
    // template is created with nextRunAt in 2099 and deactivated in a `finally` so a
    // leaked row can never fire the midnight cron, and the Run Now invoice is voided
    // there too. NOT part of F13's red gate; runs only against the DEPLOYED site and
    // is expected red until F13 ships.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's header.
    {
      name: "recurring-standing",
      testMatch: /30-recurring-standing\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: path.join(AUTH_DIR, "operator.json") },
    },

    // Un-quarantined 2026-09-03 (L-050, #598/#607): only spec 32 (active-sessions) needed a
    // dedicated seeded user — it logs in fresh as e2e_sessions_op and only ever revokes ITS OWN
    // sessions, so it must never consume the shared admin/e2e_admin every storageState:
    // operator.json project also loads. Spec 31 (impersonation-signout) mutates only its own
    // fresh session and stayed on the shared e2e_admin (as on master). e2e_sessions_op is seeded
    // by apps/api/scripts/e2e-seed.js. B138/B155 were never discharged during the quarantine
    // (L-041: a skip is not a discharge).
    // ── Impersonation sign-out (F14, spec 31) ──────────────────────────────────
    // REG-B138: while impersonating, the avatar menu offers "Exit impersonation"
    // and never "Sign out"; exiting POSTs no /auth/logout and the impersonated
    // TENANT_ADMIN's session count is unchanged (server-side, read through a token
    // the UI never touches). No storageState — the spec manages the super-admin
    // and tenant-admin sessions itself. Skips (NOT a discharge — L-041) until
    // PLAYWRIGHT_SA_* are set and e2e-seed.js has seeded `e2e_admin` on the target.
    // Targets e2e-routeflow BY SLUG, never `tenants?limit=1`.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's precedent.
    {
      name: "impersonation-signout",
      testMatch: /31-impersonation-signout\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },

    // ── Active Sessions identity (F14, spec 32) ────────────────────────────────
    // REG-B155: a session row captured BEFORE a refresh-token rotation is still
    // listed (same id, same createdAt) and can be revoked; the revoke bites (the
    // rotated token then 401s); a failed revoke re-syncs the list, and a sign-out-all
    // whose revokes all fail reports the failure instead of faking success. NO storageState
    // on purpose — the spec revokes its OWN fresh login (e2e_sessions_op) and must never
    // consume the shared operator.json refresh token.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's precedent.
    {
      name: "active-sessions",
      testMatch: /32-active-sessions\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },

    // ── Calendar-date correctness (F25, spec 34) ───────────────────────────────
    // REG-B59 / REG-B91: a stored UTC-midnight calendar date (a run's
    // scheduledDate, a customer license's expiresAt) rendered and round-tripped
    // a day early for any viewer west of UTC. `timezoneId` pins the browser to
    // America/Los_Angeles so the regression is actually observable — under the
    // suite's default (unset) timezone the bug never disagrees with the stored
    // day and this project would pass a broken build. Deploy-only proof, not
    // part of the jest red gate (T1/T2 are proven directly there); this project
    // resolving via `npx playwright test --list` is what discharges the pre-merge
    // check, the deploy-signal e2e run discharges B59/B91 themselves.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's precedent.
    {
      name: "calendar-dates",
      testMatch: /34-calendar-dates\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
        timezoneId: "America/Los_Angeles",
      },
    },

    // ── Web print surfaces (WP4, spec 38) ──────────────────────────────────────
    // R6.6/R6.10: the invoices-list row Print button must not trigger the
    // row's own navigate-to-detail click handler, and `@media print` must
    // hide the dashboard chrome. Fully mocked — no writes to any tenant.
    // Cloned from "calendar-dates" (name + spec + operator storageState reused).
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's precedent.
    {
      name: "line-note-print",
      testMatch: /38-line-note-print\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Credit-note wallet UI (F09, spec 28) ───────────────────────────────────
    // REG-B19 / REG-B18: invoice number over raw UUID on the credit-notes list
    // and detail pages, and no "Issue Credit Note" affordance. Fully mocked —
    // no writes to any tenant. Uses operator auth state.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's precedent.
    {
      name: "credit-note-wallet",
      testMatch: /28-credit-note-wallet\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Apply advance to invoice (F09, spec 38) ────────────────────────────────
    // REG-B13: web's invoice detail page can now apply a customer's
    // advance-payment wallet balance (previously mobile-only — the web hook
    // had zero callers). Mutating but self-contained: a throwaway `E2E B13 …`
    // customer + invoice on the approved seed tenant, same residue tolerance
    // 21/22/24/27/28/29 already take. Uses operator auth state.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's precedent.
    {
      name: "apply-advance",
      testMatch: /38-apply-advance\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Returns lifecycle (F08, spec 29) ───────────────────────────────────────
    // REG-B166: the returns list search box must actually filter (return #,
    // order #, or customer). REG-B75: the list's Value column and the "Total
    // Return Value" KPI must read the billed refund estimate, not $0.00.
    // REG-B21 + REG-B82: a PENDING return can be cancelled from the detail
    // page, and a cancelled return releases its quota so a second return
    // against the same order succeeds. Mutating but self-contained: throwaway
    // `E2E B08 …` product/customer/order/return fixtures on the approved seed
    // tenant, same residue tolerance 21/22/24/27/28 already take (a DELIVERED
    // order with an invoice and returns against it isn't staff-deletable
    // anyway). NOT part of F08's red gate — it runs only against the DEPLOYED
    // site (no local Playwright — test-plan.md) and is expected red until F08
    // ships. WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's
    // header for the precedent where exactly that happened and a spec sat dead.
    {
      name: "returns-lifecycle",
      testMatch: /29-returns-lifecycle\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Choose-plan routing (F18, spec 33) ─────────────────────────────────────
    // REG-B58: the /choose-plan chooser must route an in-place plan change
    // through POST /billing/subscription (upgrade) or
    // /billing/subscription/downgrade (downgrade) per the quote's `change`
    // classification, never through the fresh-subscribe endpoint. Fully
    // mocked — no writes to any tenant. Uses operator auth state.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's
    // header for the precedent where exactly that happened and a spec sat dead.
    {
      name: "change-plan-routing",
      testMatch: /33-change-plan-routing\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Route delivery-window dispatch warning (F12, spec 35) ──────────────
    // REG-B161 web leg (T2/T4): the template page's Optimize toast must name
    // the stop(s) that miss their delivery window, and the Dispatch modal
    // must warn about them and gate "Dispatch" behind an explicit
    // acknowledge. Mutating but self-contained: creates its own throwaway
    // `E2E B161 …` route + two customers (one with an always-infeasible
    // delivery window) on the approved seed tenant and cleans up nothing,
    // the same tolerance 21/22/23/24's own throwaway fixtures already take.
    // NOT part of F12's local red gate (apps/api's jest lane proves T1-T3) —
    // runs only against the DEPLOYED site and is expected red until F12
    // ships.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's
    // header for the precedent where exactly that happened and a spec sat dead.
    {
      name: "route-windows",
      testMatch: /35-route-windows\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── List caps / silent truncation (F16, spec 37) ───────────────────────────
    // REG-B12 / REG-B80 / REG-B144 / REG-B110: the invoices KPI bar, the
    // payment receipt page, orders search, and the customer statement tiles
    // must all stop silently truncating past a hardcoded fetch-everything
    // limit. Mutating but self-contained: throwaway `E2E B144 …` / `E2E B80
    // …` / `E2E B110 …` customer/invoice/order fixtures on the approved seed
    // tenant, left behind like 21/22/24/27/28's own throwaway fixtures. NOT
    // part of F16's local red gate (apps/api's jest lane proves T1-T6) — runs
    // only against the DEPLOYED site and is expected red until F16 ships.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's
    // header for the precedent where exactly that happened and a spec sat dead.
    {
      name: "list-caps",
      testMatch: /37-list-caps\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },

    // ── Marketing site port (spec 36) ──────────────────────────────────────────
    // Signed-out throughout — no storageState, no "setup" dependency. Proves T1
    // (per-route chrome/copy), T2 (mobile sheet/sign-in/contact-form/tabs/FAQ),
    // T3 (internal link crawl), T12 (mobile UA still reaches the marketing site).
    // Desktop Chrome by default; T2's mobile assertions opt into
    // devices["iPhone 13"] inside the spec via test.use() on that describe block.
    // NOT part of the local red gate (test-plan.md "Harness notes") — this
    // project resolving/running is the post-deploy proof, same convention as
    // 08-create-order-escape's precedent for "without this entry the spec never
    // runs".
    {
      name: "marketing",
      testMatch: /36-marketing-site\.spec\.ts/,
      dependencies: [],
      use: { ...devices["Desktop Chrome"] },
    },
    // Auth interface redesign (spec 46) — same convention as "marketing":
    // NOT part of the local red gate (test-plan.md "Harness notes") — this
    // project resolving/running is the post-deploy proof.
    {
      name: "auth-redesign",
      testMatch: /46-auth-redesign\.spec\.ts/,
      dependencies: [],
      use: { ...devices["Desktop Chrome"] },
    },

    // ── Lite-plan nav/route gating (lite-L2, spec 47) ──────────────────────────
    // R2.2/R2.5/R2.6/R2.8/R3b.8/R4.3/R4.5/R7.7: the sidebar/route gate for a LITE-plan
    // tenant, Settings → Billing's "Complete payment", and choose-plan/marketing never
    // rendering a "Lite" card. Self-skips (test.skip, not a discharge — L-041) when
    // PLAYWRIGHT_LITE_TENANT_SLUG is unset — it needs a dedicated LITE-plan tenant the
    // shared operator.json fixture is not on. NOT in the local Playwright allow-list
    // (apps/web/e2e/LOCAL-LANE.md) — post-deploy only, same convention as
    // sales-agents-gate/compliance-pack-gate/trip-builder-gate above.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's precedent.
    {
      name: "lite-plan-gate",
      testMatch: /47-lite-plan-gate\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
      },
    },
    // House-tenant / MRR reconciliation (spec 47, review round 2026-09-15) — mirrors
    // "super-admin"'s auth shape exactly (same setup dependency, same storageState). NOT in
    // LOCAL-LANE.md's allow-list, same as "super-admin": no SA creds are seeded locally, so
    // this project's tests self-skip everywhere except where PLAYWRIGHT_SA_* is set (the
    // post-deploy E2E run). Read-only against routeflow-hq — see the spec file's header.
    {
      name: "house-tenant-mrr",
      testMatch: /47-house-tenant-mrr-verify\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "super-admin.json"),
      },
    },
  ],
});
