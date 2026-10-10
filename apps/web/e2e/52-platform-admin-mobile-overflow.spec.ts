/**
 * Platform-admin mobile overflow — B559, spec 52.
 *
 * The owner reported the TENANT DETAIL page's "Setup" tab broken at
 * ~390px: content clipped at the left edge, the page "moves around and won't
 * settle". Root cause: `(platform-admin)/_components/AdminTabs.tsx` rendered its
 * 5 tabs in a plain `flex` row with no wrap, no `overflow-x-auto`, and no
 * `min-w-0` on the tab buttons — the browser's default `min-width: auto` on a
 * flex item means the row cannot shrink below its combined min-content width
 * (~621px measured at 390px viewport). That overflow isn't clipped by anything
 * until `(platform-admin)/layout.tsx`'s `<main className="flex-1 overflow-y-auto">`
 * shell — which the CSS Overflow spec silently turns into a SECOND scroll
 * container too (`overflow-y: auto` forces the sibling axis to computed
 * `overflow-x: auto` instead of `visible`). `document.documentElement.scrollWidth`
 * NEVER reflects this: it stays exactly `window.innerWidth` on every tab, at
 * rest and after interaction, because `<main>` absorbs the overflow before it
 * ever reaches the document. That is why an earlier sweep's
 * `documentElement.scrollWidth <= innerWidth` probe (the same helper this
 * repo's own e2e/49-deliveries-new-responsive.spec.ts calls
 * `assertNoHorizontalScroll`) reported this exact page/tab "clean" — the probe
 * is structurally blind to overflow contained in an inner scroll container. The
 * visible "moves around" symptom is the browser's native focus-scroll-into-view
 * firing on `<main>` (the nearest scrollable ancestor) when a tab button that
 * sits beyond the visible column is clicked, snapping `main.scrollLeft` and
 * clipping everything to its left.
 *
 * Compounding the miss: `activeTab` is React state on ONE url
 * (`/admin/tenants/[id]`), not a route or query param — a URL-driven sweep that
 * visits each of its 33 screens once, at rest, on first paint never fires the
 * tab's onClick and never renders anything past the default "Overview" tab.
 *
 * This spec uses the RIGHT probe instead: at 390/768/1440, walk every element
 * in the DOM and assert none of them has a bounding-box edge outside
 * `[0, innerWidth]` — this catches overflow wherever it's contained (an inner
 * scroll container, a sticky/fixed element, a transform), not just at
 * `documentElement`. It also asserts the legacy document-level check as a
 * belt-and-braces regression guard, and separately re-runs the real-element
 * check after clicking into every tab (state, not just the URL's default).
 *
 * The probe itself now lives in helpers/overflow.ts — 53 (operator dashboard)
 * and 54 (buyer portal) reuse it verbatim (owner-reported: mobile pages drift
 * sideways and don't settle after pinch-zoom; this shell was the third of
 * three shells with the same class of gap, see globals.css and those specs'
 * headers).
 *
 * Read-only: no tenant/buyer data is created or mutated, matching
 * 01-super-admin.spec.ts's convention. Targets the seeded e2e-routeflow tenant
 * (approved test tenant) — never a live client tenant.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { HAS_SUPER_ADMIN_CREDS, TENANT_SLUG } from "./helpers/constants";
import { assertNoOverflow, documentLevelOverflowPx } from "./helpers/overflow";

// B836: HAS_SUPER_ADMIN_CREDS alone only checks the PLAYWRIGHT_SA_USERNAME/
// PASSWORD env vars — a lane holding an already-authenticated, still-valid
// super-admin.json (from a prior owner-credentialed run in the same window)
// had no way to re-run this spec without asking the owner to type the
// password again. Scoped to this spec only, not HAS_SUPER_ADMIN_CREDS itself
// (that constant gates 7 other specs, several of which need a LIVE login to
// exercise, not just a saved session — auth.setup.ts among them). A stub
// with no cookies (the placeholder Playwright writes when the setup project
// skips itself) must still count as "no session" — checked, not assumed.
function hasSavedSuperAdminSession(): boolean {
  const storageStatePath = path.join(__dirname, "setup", ".auth", "super-admin.json");
  if (!fs.existsSync(storageStatePath)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(storageStatePath, "utf8"));
    return Array.isArray(state.cookies) && state.cookies.length > 0;
  } catch {
    return false;
  }
}

test.skip(
  !HAS_SUPER_ADMIN_CREDS && !hasSavedSuperAdminSession(),
  "PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD not set, and no saved super-admin session found",
);

const VIEWPORTS = [
  { width: 390, height: 844, label: "390" },
  { width: 768, height: 1024, label: "768" },
  { width: 1440, height: 900, label: "1440" },
] as const;

const PROOF_DIR = path.join(
  __dirname,
  "../../../local-assets/proofs/2026-09-18/platform-admin-mobile",
);

async function screenshot(page: Page, name: string) {
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  await page.screenshot({ path: path.join(PROOF_DIR, name), fullPage: false });
}

for (const vp of VIEWPORTS) {
  test.describe(`platform-admin — ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`no element exceeds the viewport across every platform-admin screen (${vp.label}px)`, async ({
      page,
    }) => {
      // This test walks ~14 screens (several with a tab-click round-trip) at
      // one viewport — generous budget over the config default so a slow
      // dev box doesn't turn a real overflow-check failure into a timeout.
      test.setTimeout(240_000);

      // ── Platform dashboard ──────────────────────────────────────────────
      await page.goto("/admin/dashboard");
      await expect(page.getByText(/platform dashboard/i)).toBeVisible({ timeout: 15_000 });
      await assertNoOverflow(page, "admin/dashboard");
      expect(await documentLevelOverflowPx(page)).toBeLessThanOrEqual(0);
      await screenshot(page, `${vp.label}-01-dashboard.png`);

      // ── Tenants list ─────────────────────────────────────────────────────
      await page.goto("/admin/tenants");
      await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 15_000 });
      await assertNoOverflow(page, "admin/tenants (list)");
      await screenshot(page, `${vp.label}-02-tenants-list.png`);

      // ── Tenant detail — click through the list UI (real navigation, not a
      // side-channel API call) to reach the seeded test tenant's detail page.
      const tenantLink = page.locator(`table tbody tr:has-text("${TENANT_SLUG}") a`).first();
      test.skip(
        (await tenantLink.count()) === 0,
        `no "${TENANT_SLUG}" row in the tenants table — seed may not have run`,
      );
      await tenantLink.click();
      // 30s, not 15s — found flaking for real (owner's run): under `next
      // dev`, the FIRST hit on /admin/tenants/[id] pays a one-time
      // on-demand compile that can exceed 15s even though the click and
      // navigation both genuinely succeed. Same allowance as specs 53/54's
      // own cold-compile bumps.
      await expect(page.getByRole("button", { name: "Overview" })).toBeVisible({
        timeout: 30_000,
      });
      // Overview (the default tab — what a URL-only sweep would have seen).
      await assertNoOverflow(page, "admin/tenants/[id] — Overview");
      expect(await documentLevelOverflowPx(page)).toBeLessThanOrEqual(0);
      await screenshot(page, `${vp.label}-03-tenant-detail-overview.png`);

      // Every other tab is REACT STATE on this one URL — a URL-driven sweep
      // never clicks into these. Click each and re-assert, proving the fix
      // holds under the exact interaction that exposed the bug.
      const tabs = [
        { name: "Billing & Subscription", shot: "tenant-detail-billing" },
        { name: "Setup", shot: "tenant-detail-addons" },
        { name: "Configuration", shot: "tenant-detail-config" },
        { name: "Audit Log", shot: "tenant-detail-audit" },
      ];
      for (const tab of tabs) {
        await page.getByRole("button", { name: tab.name }).click();
        await assertNoOverflow(page, `admin/tenants/[id] — ${tab.name}`);
        expect(await documentLevelOverflowPx(page)).toBeLessThanOrEqual(0);
        // `<main>` is the actual scroll container for this shell (see header) —
        // assert it directly too, not just via documentElement.
        const mainOverflow = await page.evaluate(() => {
          const main = document.querySelector("main");
          return main ? main.scrollWidth - main.clientWidth : 0;
        });
        expect(mainOverflow, `<main> overflow on ${tab.name}`).toBeLessThanOrEqual(0);
        await screenshot(page, `${vp.label}-04-${tab.shot}.png`);
      }

      // ── Tenant — new ─────────────────────────────────────────────────────
      await page.goto("/admin/tenants/new");
      await assertNoOverflow(page, "admin/tenants/new");
      await screenshot(page, `${vp.label}-05-tenant-new.png`);

      // ── Buyers list ──────────────────────────────────────────────────────
      await page.goto("/admin/buyers");
      await assertNoOverflow(page, "admin/buyers (list)");
      await screenshot(page, `${vp.label}-06-buyers-list.png`);

      // ── Buyer detail (both tabs — also client state, same class of risk) ──
      // Click through the list UI (real navigation) rather than a side-channel
      // API call — one fewer thing to time out on a loaded box.
      const manageLink = page.getByRole("link", { name: "Manage" }).first();
      if (await manageLink.count()) {
        await manageLink.click();
        // 30s — same cold-compile allowance as the tenant-detail navigation
        // above, for /admin/buyers/[id]'s first hit.
        await expect(page.getByRole("button", { name: "Profile" })).toBeVisible({
          timeout: 30_000,
        });
        await assertNoOverflow(page, "admin/buyers/[id] — Profile");
        await screenshot(page, `${vp.label}-07-buyer-detail-profile.png`);

        await page.getByRole("button", { name: /Seller Links/i }).click();
        await assertNoOverflow(page, "admin/buyers/[id] — Seller Links");
        await screenshot(page, `${vp.label}-08-buyer-detail-sellers.png`);
      }

      // ── Merge requests ───────────────────────────────────────────────────
      await page.goto("/admin/buyers/merge-requests");
      await assertNoOverflow(page, "admin/buyers/merge-requests");
      await screenshot(page, `${vp.label}-09-merge-requests.png`);

      // ── Plans & pricing ──────────────────────────────────────────────────
      await page.goto("/admin/plans");
      await assertNoOverflow(page, "admin/plans");
      await screenshot(page, `${vp.label}-10-plans.png`);

      // ── Platform billing ─────────────────────────────────────────────────
      await page.goto("/admin/billing");
      await assertNoOverflow(page, "admin/billing");
      await screenshot(page, `${vp.label}-11-billing.png`);

      // ── Audit logs ───────────────────────────────────────────────────────
      await page.goto("/admin/audit-logs");
      await assertNoOverflow(page, "admin/audit-logs");
      await screenshot(page, `${vp.label}-12-audit-logs.png`);

      // ── Settings (AI usage panel lives here) ────────────────────────────
      await page.goto("/admin/settings");
      await assertNoOverflow(page, "admin/settings");
      await screenshot(page, `${vp.label}-13-settings.png`);

      // ── Profile ──────────────────────────────────────────────────────────
      await page.goto("/admin/profile");
      await assertNoOverflow(page, "admin/profile");
      await screenshot(page, `${vp.label}-14-profile.png`);
    });
  });
}
