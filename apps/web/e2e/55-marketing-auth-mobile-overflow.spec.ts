/**
 * Marketing + auth mobile overflow — owner report, spec 55.
 *
 * Of the app's shells, marketing and auth are the two with NO containment of
 * their own: auth has no `layout.tsx` at all (confirmed for every page listed
 * below, both `(auth)`'s operator pages and `app/buyer/*`'s buyer pages —
 * neither the individual route folder nor any shared route-group layout
 * exists), and marketing's layout has no overflow class anywhere in it. For
 * every other shell this batch fixed (operator dashboard, buyer portal,
 * platform-admin), the new `html { overflow-x: hidden }` safety net in
 * apps/web/app/globals.css is a backstop on top of an explicit element-level
 * fix — see specs 52/53/54's own headers. For these pages, it's the ONLY
 * containment that exists: if it were ever removed or scoped away from one
 * of them, nothing else here would catch a regression.
 *
 * This spec covers the pages found and fixed in this PR's own review round
 * — it is NOT an exhaustive sweep of every global-rule-only page in the app
 * (a prior version of this comment overclaimed "regression-locked" coverage
 * without actually including the operator `(auth)` pages below; corrected
 * per review). Pages: the buyer auth flow (login, register, invite,
 * forgot-password, reset-password, verify-email, verify-merge,
 * change-password — register/invite/verify-merge have no operator-side
 * equivalent, they're buyer-account concepts), the operator-side `/login`
 * and `/forgot-password` (added per review — these were left out of the
 * first pass even though they have exactly the same no-layout shape as their
 * buyer counterparts), and the global not-found page.
 *
 * Read-only: no data is created or mutated. Targets the seeded e2e-routeflow
 * tenant (approved test tenant) — never a live client tenant.
 */
import { test, expect } from "@playwright/test";
import { assertNoOverflow, documentLevelOverflowPx, waitForDataLoaded } from "./helpers/overflow";

const VIEWPORTS = [
  { width: 390, height: 844, label: "390" },
  { width: 768, height: 1024, label: "768" },
  { width: 1440, height: 900, label: "1440" },
] as const;

// Every one of these route folders has no layout.tsx of its own — confirmed
// directly, not assumed — so each depends entirely on the root layout +
// globals.css's global rule for horizontal containment.
const GLOBAL_RULE_ONLY_PAGES = [
  { label: "operator login", path: "/login" },
  { label: "operator forgot-password", path: "/forgot-password" },
  { label: "buyer login", path: "/buyer/login" },
  { label: "buyer register", path: "/buyer/register" },
  // No real invite token exists (or needs to) for this check — the page's
  // own invalid/expired-invite state is still real rendered content or an
  // overflow bug could hide in the error copy just as easily.
  { label: "buyer invite (invalid token)", path: "/buyer/invite/e2e-overflow-check-invalid" },
  { label: "buyer forgot-password", path: "/buyer/forgot-password" },
  // No real reset token either — same reasoning as invite above.
  { label: "buyer reset-password (no token)", path: "/buyer/reset-password" },
  { label: "buyer verify-email (no token)", path: "/buyer/verify-email" },
  { label: "buyer verify-merge (no token)", path: "/buyer/verify-merge" },
  { label: "buyer change-password", path: "/buyer/change-password" },
  { label: "not-found", path: "/this-page-does-not-exist-e2e-55" },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`marketing + auth (global-rule-only pages) — ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`no element exceeds the viewport on any page relying solely on the global rule (${vp.label}px)`, async ({
      page,
    }) => {
      test.setTimeout(120_000);

      for (const { label, path } of GLOBAL_RULE_ONLY_PAGES) {
        await page.goto(path);
        await waitForDataLoaded(page);
        await assertNoOverflow(page, label);
        expect(await documentLevelOverflowPx(page)).toBeLessThanOrEqual(0);
      }
    });
  });
}

test.describe("marketing mobile menu — scroll-lock + sticky header under the global rule", () => {
  // 390 only: this checks a specific interaction (open the sheet after
  // scrolling), not a viewport sweep — see specs 53's 280px dropdown test
  // for the same reasoning (a dedicated width for a dedicated behavior).
  test.use({ viewport: { width: 390, height: 844 } });

  test("opening the sheet after scrolling locks background scroll without breaking the sticky header, and closing it restores scroll", async ({
    page,
  }) => {
    // The concern this test exists for (pre-merge review, not found by this
    // branch's own exploration): `html { overflow-x: hidden }` makes html's
    // computed overflow non-visible on the x axis, which per CSS Overflow 3
    // §3.3's axis-pairing rule also computes overflow-y to `auto` (not
    // `visible`) — silently turning <html> into an overflow box, the exact
    // pattern this PR's platform-admin fix (B559's root cause) diagnosed as
    // dangerous elsewhere. If browsers actually built the box that way here,
    // it could compete with Radix Dialog's own body-level scroll lock (the
    // mobile sheet is a Radix Dialog, see site-header.tsx) or with
    // `.site-header`'s `position: sticky`, which breaks if any ancestor in
    // its containing-block chain gains a non-`visible` overflow. Per spec,
    // overflow set on the ROOT element is instead propagated to the
    // viewport and the root's own used value stays `visible` — so in theory
    // neither should happen. That's a spec reading, not a browser
    // observation, and this branch has already gotten a CSS-spec claim
    // wrong once before (the clip-vs-hidden reasoning, corrected on a
    // second pass) — hence an actual test instead of trusting the reasoning.
    await page.goto("/");
    await page.evaluate(() => window.scrollTo(0, 400));
    const scrollYBeforeOpen = await page.evaluate(() => window.scrollY);
    expect(
      scrollYBeforeOpen,
      "page must actually be scrolled for this test to mean anything",
    ).toBeGreaterThan(100);

    // Baseline, added per review: prove the wheel gesture itself actually
    // scrolls the page BEFORE the sheet ever opens. Without this, "scrollY
    // didn't change while the sheet was open" is equally consistent with a
    // working scroll-lock OR with the wheel event just not doing anything on
    // this page/environment to begin with — the assertion below would pass
    // for the wrong reason either way.
    await page.mouse.wheel(0, 100);
    await expect
      .poll(() => page.evaluate(() => window.scrollY), {
        message:
          "the wheel gesture didn't scroll the page while the sheet was closed — this test's own baseline is broken, not proof of a lock",
      })
      .toBeGreaterThan(scrollYBeforeOpen);
    const scrollYBaseline = await page.evaluate(() => window.scrollY);

    await page.getByRole("button", { name: /open menu/i }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    // Scroll-lock proof: attempt to scroll the background while the sheet is
    // open, then confirm the page didn't move. A real scroll-lock (Radix's
    // own, via react-remove-scroll) intercepts this; our global rule doing
    // something unexpected to html/body would show up here as a discrepancy.
    // expect.poll, not a single synchronous read right after the wheel event
    // (review's finding: the read could race the scroll effect) — a poll
    // that already matches on its first check still passes immediately, so
    // this doesn't weaken the "never moved" claim, it just stops a fast
    // browser turning a real race into a false pass.
    await page.mouse.wheel(0, 300);
    await expect
      .poll(() => page.evaluate(() => window.scrollY), {
        message: "background scrolled while the mobile sheet was open",
      })
      .toBe(scrollYBaseline);

    // The sheet itself must not introduce new horizontal overflow either.
    await assertNoOverflow(page, "marketing mobile menu — sheet open, scrolled");

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // Scroll must be restored, not stuck locked — and the header, having
    // been `position: sticky` under the "page is scrolled" state the whole
    // time, must still be visible/functional afterward (a broken sticky
    // context after a lock/unlock cycle would show up as either the header
    // disappearing or the page failing to scroll further).
    await expect
      .poll(() => page.evaluate(() => window.scrollY), {
        message: "scroll position lost or altered by opening/closing the sheet",
      })
      .toBe(scrollYBaseline);
    await expect(page.locator(".site-header")).toBeVisible();
    await page.mouse.wheel(0, 300);
    await expect
      .poll(() => page.evaluate(() => window.scrollY), {
        message:
          "page can no longer scroll after the sheet was opened and closed — scroll-lock stuck",
      })
      .toBeGreaterThan(scrollYBaseline);
  });
});
