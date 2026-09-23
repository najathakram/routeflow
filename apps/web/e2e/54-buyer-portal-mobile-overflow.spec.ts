/**
 * Buyer portal mobile overflow — owner report, spec 54.
 *
 * The owner reported that on a phone browser nearly every page drifts
 * horizontally on a vertical swipe, and after pinch-zooming the page does not
 * settle back to full width. Of the four shells this app has, the buyer
 * portal was the closest match to the reported symptom: `buyer/portal/layout.tsx`'s
 * `<main>` set `overflow-auto` (both axes live) rather than constraining the
 * horizontal axis, so its main element could drag diagonally on every buyer
 * page. Fixed to explicit `overflow-x-hidden overflow-y-auto`, backed by the
 * new project-wide `html { overflow-x: clip }` safety net in
 * apps/web/app/globals.css (see that file's comment for why `clip` rather
 * than `hidden`, and why zoom itself is deliberately never locked).
 *
 * Uses the same probe as 52-platform-admin-mobile-overflow.spec.ts (see that
 * spec's header for why a naive `documentElement.scrollWidth <= innerWidth`
 * check is blind to overflow an inner `overflow-*: auto` container absorbs)
 * via the shared helpers/overflow.ts.
 *
 * Scope: the pages a buyer actually spends time on — dashboard, shop, cart,
 * orders, and invoices — not every route this portal has.
 *
 * Uses the seeded, ACTIVE-linked buyer credential from helpers/constants.ts
 * (already has a seller selected, so no register→invite→accept dance is
 * needed here — that belongs to specs that test the invite flow itself, e.g.
 * 04-buyer-portal.spec.ts / 17-buyer-shop-density-detail.spec.ts). Read-only:
 * no data is created or mutated. Targets the seeded e2e-routeflow tenant
 * (approved test tenant) — never a live client tenant.
 */
import { test, expect } from "@playwright/test";
import { loginAsBuyer } from "./helpers/auth";
import { CREDENTIALS } from "./helpers/constants";
import { assertNoOverflow, documentLevelOverflowPx } from "./helpers/overflow";

const VIEWPORTS = [
  { width: 390, height: 844, label: "390" },
  { width: 768, height: 1024, label: "768" },
  { width: 1440, height: 900, label: "1440" },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`buyer portal — ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`no element exceeds the viewport across the buyer's own pages (${vp.label}px)`, async ({
      page,
    }) => {
      test.setTimeout(120_000);

      await loginAsBuyer(page, CREDENTIALS.buyer.email, CREDENTIALS.buyer.password);

      // This seeded buyer lands on the bare "Your Sellers" picker
      // (/buyer/portal), not directly on a seller-scoped URL — despite being
      // ACTIVE-linked to one seller, the app still requires the explicit
      // click (real product behavior, not a test-setup gap). Assert the
      // picker itself is clean before clicking through, since it's a real
      // page a buyer sees.
      await expect(page.getByText(/select a seller/i)).toBeVisible({ timeout: 15_000 });
      await assertNoOverflow(page, "buyer — seller picker");
      await page.getByText("E2E Test RouteFlow", { exact: false }).first().click();
      await page.waitForURL(/\/buyer\/portal\/[^/]+/, { timeout: 15_000 });

      const sellerSlug = page.url().split("/buyer/portal/")[1]?.split("/")[0];
      test.skip(
        !sellerSlug,
        "buyer has no active seller selected — cannot reach seller-scoped pages",
      );

      // ── Dashboard (navigate there explicitly — the click above lands on
      // orders, not dashboard) ────────────────────────────────────────────
      await page.goto(`/buyer/portal/${sellerSlug}/dashboard`);
      await assertNoOverflow(page, "buyer dashboard");
      expect(await documentLevelOverflowPx(page)).toBeLessThanOrEqual(0);
      // The buyer main element is this shell's own scroll container (see
      // header) — assert it directly too, not just via documentElement.
      const mainOverflowAtDashboard = await page.evaluate(() => {
        const main = document.querySelector("main");
        return main ? main.scrollWidth - main.clientWidth : 0;
      });
      expect(mainOverflowAtDashboard, "<main> overflow on buyer dashboard").toBeLessThanOrEqual(0);

      // ── Shop ─────────────────────────────────────────────────────────────
      await page.goto(`/buyer/portal/${sellerSlug}/shop`);
      await assertNoOverflow(page, "buyer shop");

      // ── Cart ─────────────────────────────────────────────────────────────
      await page.goto(`/buyer/portal/${sellerSlug}/cart`);
      await assertNoOverflow(page, "buyer cart");

      // ── Orders ───────────────────────────────────────────────────────────
      await page.goto(`/buyer/portal/${sellerSlug}/orders`);
      await assertNoOverflow(page, "buyer orders (list)");

      // Real order detail, only if one exists — real navigation through the
      // list rather than a side-channel API call.
      const firstOrderLink = page.locator(`a[href^="/buyer/portal/${sellerSlug}/orders/"]`).first();
      if (await firstOrderLink.count()) {
        await firstOrderLink.click();
        await assertNoOverflow(page, "buyer orders/[id]");
        expect(await documentLevelOverflowPx(page)).toBeLessThanOrEqual(0);
      }

      // ── Invoices ─────────────────────────────────────────────────────────
      await page.goto(`/buyer/portal/${sellerSlug}/invoices`);
      await assertNoOverflow(page, "buyer invoices (list)");
    });
  });
}
