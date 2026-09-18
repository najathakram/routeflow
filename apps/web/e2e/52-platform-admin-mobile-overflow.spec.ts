/**
 * Platform-admin mobile overflow — B559, spec 52.
 *
 * The owner reported the TENANT DETAIL page's "Addons & Features" tab broken at
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
 * Read-only: no tenant/buyer data is created or mutated, matching
 * 01-super-admin.spec.ts's convention. Targets the seeded e2e-routeflow tenant
 * (approved test tenant) — never a live client tenant.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { HAS_SUPER_ADMIN_CREDS, TENANT_SLUG } from "./helpers/constants";

test.skip(!HAS_SUPER_ADMIN_CREDS, "PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD not set");

const VIEWPORTS = [
  { width: 390, height: 844, label: "390" },
  { width: 768, height: 1024, label: "768" },
  { width: 1440, height: 900, label: "1440" },
] as const;

const PROOF_DIR = path.join(
  __dirname,
  "../../../local-assets/proofs/2026-09-18/platform-admin-mobile",
);

interface Offender {
  tag: string;
  cls: string;
  text: string;
  left: number;
  right: number;
}

/** The RIGHT probe (see header): any element whose rendered box escapes the
 * viewport horizontally, wherever the overflow is actually contained — EXCEPT
 * inside a wrapper this codebase deliberately marked scrollable
 * (`overflow-x-auto`/`overflow-x-scroll` in its own authored className, per
 * the house pattern CLAUDE.md documents: a data table wrapped in
 * `overflow-x-auto` with an explicit `min-w-[Npx]`, e.g. the tenants list).
 * That is intentional, reachable-by-scroll UX, not the bug this spec hunts.
 * The AdminTabs bug is different in exactly this respect: `<main>`'s
 * `overflow-x: auto` is never authored — it's the CSS Overflow spec's side
 * effect of `overflow-y: auto` alone (see header) — so it never matches this
 * allowlist and stays flagged. Only a wrapper BOTH marked scrollable AND
 * itself fitting the viewport counts (an unbounded "scrollable" wrapper that
 * itself escapes the viewport is still a real bug). Returns the worst
 * offenders (by how far they escape) so a failure is diagnosable, not just
 * "something, somewhere is 37px too wide". */
async function findViewportOverflow(page: Page): Promise<Offender[]> {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const offenders: Array<{
      tag: string;
      cls: string;
      text: string;
      left: number;
      right: number;
      escape: number;
    }> = [];
    document.querySelectorAll("body *").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const rightEscape = r.right - vw;
      const leftEscape = -r.left;
      const escape = Math.max(rightEscape, leftEscape);
      if (escape <= 1) return;

      let node: Element | null = el.parentElement;
      while (node && node !== document.body) {
        const cls = (node.className || "").toString();
        if (/overflow-x-(auto|scroll)/.test(cls)) {
          const wr = node.getBoundingClientRect();
          if (wr.right <= vw + 1 && wr.left >= -1) return; // contained, intentional scroll
        }
        node = node.parentElement;
      }

      offenders.push({
        tag: el.tagName,
        cls: (el.className || "").toString().slice(0, 90),
        text: (el.textContent || "").trim().slice(0, 40),
        left: Math.round(r.left),
        right: Math.round(r.right),
        escape: Math.round(escape),
      });
    });
    offenders.sort((a, b) => b.escape - a.escape);
    return offenders.slice(0, 5);
  });
}

/** Legacy document-level check — kept as a regression guard, but NOT sufficient
 * on its own (see header): it never trips for this bug class because the
 * overflow is absorbed by an inner `overflow-y:auto` container before it
 * reaches `documentElement`. */
async function documentLevelOverflowPx(page: Page): Promise<number> {
  const [scrollWidth, innerWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  return scrollWidth - innerWidth;
}

async function assertNoOverflow(page: Page, screenLabel: string) {
  const offenders = await findViewportOverflow(page);
  expect(
    offenders,
    `viewport overflow on ${screenLabel} at ${page.viewportSize()?.width}px — worst offenders: ${JSON.stringify(offenders)}`,
  ).toHaveLength(0);
}

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
      await expect(page.getByRole("button", { name: "Overview" })).toBeVisible({
        timeout: 15_000,
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
        { name: "Addons & Features", shot: "tenant-detail-addons" },
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
        await expect(page.getByRole("button", { name: "Profile" })).toBeVisible({
          timeout: 15_000,
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
