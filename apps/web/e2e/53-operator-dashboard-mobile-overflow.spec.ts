/**
 * Operator dashboard mobile overflow — owner report, spec 53.
 *
 * The owner reported that on a phone browser nearly every page drifts
 * horizontally on a vertical swipe, and after pinch-zooming the page does not
 * settle back to full width. Root cause (see apps/web/app/globals.css's new
 * `html { overflow-x: hidden }` rule and this shell's own layout.tsx): every
 * shell handled overflow differently and nothing caught what escaped one.
 * The operator dashboard shell — `(dashboard)/layout.tsx`'s
 * `<main className="flex-1 overflow-x-hidden overflow-y-auto ...">` — was
 * already the best-guarded of the four shells (explicit both axes), so this
 * spec is largely a regression lock on it plus the two things this batch
 * actually changed here: the global `html` net, and the header notification
 * dropdown (`(dashboard)/layout.tsx`'s `DropdownMenu.Content`), which portals
 * to `document.body` at a fixed `w-80` with no viewport clamp — a portal
 * escapes every shell's own containment, so it needed its own fix (mirroring
 * `packages/ui/src/web/Toast.tsx`'s `max-w-[calc(100vw-2rem)]` clamp) rather
 * than relying on this shell's `<main>`.
 *
 * Uses the same probe as 52-platform-admin-mobile-overflow.spec.ts (see that
 * spec's header for the full write-up of why a naive
 * `documentElement.scrollWidth <= innerWidth` check is blind to overflow
 * absorbed by an inner scroll container) — now shared via helpers/overflow.ts.
 *
 * Scope: a representative set of the pages the owner actually uses, not an
 * exhaustive sweep of this shell's ~25 route groups (that breadth belongs to
 * a dedicated responsive-QA pass, not a bug-fix PR) — dashboard, orders
 * (list + a real order detail), customers, products, invoices, routes,
 * settings, and the notification dropdown opened on top of each. Customers
 * and invoices are visited at every width, but at 390 only, each ignores its
 * own already-filed, unrelated defect — not the whole page, and not at
 * 768/1440, where there's room and no ignore applies: an unwrapped toolbar on
 * customers (B749, matched by its "New Customer" button text) and B750 on
 * invoices, ignored by container (`table` — this page has exactly one, and a
 * plain tag allowlist misses row-action buttons/icons nested inside an
 * overflowing cell). B750's own filed description undersells it: the table's
 * wrapper is `overflow-hidden`, not a scrollable `overflow-auto` — it clips
 * with NO way to reach the cut-off content, not "needs scrolling to see."
 * Invoices ALSO has a third, previously unfiled instance of B749's exact
 * toolbar shape (matched by its "New Invoice" button text) — found while
 * investigating B750, reported, not fixed here. Narrowed this way rather
 * than excluded outright, so a regression anywhere else on either page still
 * fails. See isB749Toolbar/isInvoicesToolbar/B750_TABLE_CONTAINER below.
 *
 * The notification-dropdown clamp itself is untested BELOW 352px here: Radix
 * already repositions the menu to stay on screen above that width via its own
 * collision avoidance, so 390/768/1440 all pass whether or not the
 * max-w-[calc(100vw-2rem)] clamp this batch added is even present. A
 * dedicated 280px-viewport test below proves the clamp specifically — narrower
 * than the panel's own natural 320px width, where repositioning alone can't
 * help and the clamp has to actually shrink it.
 *
 * Read-only: no data is created or mutated. Targets the seeded e2e-routeflow
 * tenant (approved test tenant) — never a live client tenant.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  assertNoOverflow,
  documentLevelOverflowPx,
  waitForDataLoaded,
  type Offender,
} from "./helpers/overflow";

// B749: the customers-list toolbar's "New Customer" button group has no wrap
// and overflows at 390. Matched by text rather than class — the offending
// classes (`shrink-0`, `flex items-center gap-2`) are generic Tailwind
// utilities shared all over the app; the toolbar's own button labels are the
// stable thing to match on this specific page.
const isB749Toolbar = (o: Offender) => o.text.includes("New Customer");

// B750: the invoices-list table's own wrapper is overflow-hidden (clips,
// offers NO scroll access at all — worse than "the invoices-list table has
// no scroll wrapper", the description this was filed under; there IS a
// wrapper, it just clips instead of scrolling) and overflows at 390.
// Two selectors, for two DIFFERENT passes' offender shapes (found running
// this for real, once helpers/overflow.ts's second pass started honoring
// ignoreContainer too): "table" catches the escape-pass's offenders — row-
// action buttons/icons NESTED INSIDE an overflowing cell, matched via
// `el.closest("table")` since they're descendants of one; a plain tag
// allowlist would miss them even though their ancestor TD/TR tags matched.
// "div:has(> table)" catches the clip-pass's offender instead — that pass
// flags the WRAPPER div itself (its own overflow-hidden class + scrollWidth
// > clientWidth), which is an ANCESTOR of the table, not a descendant, so
// `closest("table")` alone never matches it.
const B750_TABLE_CONTAINER = ["table", "div:has(> table)"];

// Third instance of the SAME toolbar-overflow shape as B749 (a no-wrap
// `flex items-center gap-2` action row), found on the invoices list while
// investigating B750 above — NOT covered by either B749 or B750's filing.
// Matched by text, same reason as isB749Toolbar, but two patterns are
// needed: the wrapping divs' CONCATENATED text ("Export Payments Received
// Recurring New Invoice", truncated by helpers/overflow.ts's 40-char cap to
// "...New Invo") AND the rightmost "New Invoice" BUTTON's own, un-truncated,
// individually-escaping text — both independently register as offenders
// since the probe walks every element, not just the outermost one.
const isInvoicesToolbar = (o: Offender) =>
  o.text.includes("ExportPayments") || o.text === "New Invoice";

// Found by pre-merge review, not by this branch's own exploration: the
// dashboard's order-pipeline strip ((dashboard)/dashboard/page.tsx:788-789)
// hard-clips "Cancelled" to "Cancelle" inside an overflow-hidden wrapper — a
// class of miss the escape-based probe alone can never catch (see
// helpers/overflow.ts's module header for the two-pass explanation).
//
// Container-matched, not text-matched — found running this for real: the
// second pass's `scrollWidth > clientWidth` check fires on the OUTER wrapper
// (the only element in this strip actually carrying the `overflow-hidden`
// class; the individual "Cancelled" label span does not), so the offender's
// own `text` is the wrapper's FULL concatenated textContent ("2Pending0Con...",
// truncated to 40 chars) — "Cancelled" sits at the END of that string and
// never survives the truncation. A text-based `ignore` predicate looking for
// "Cancelle" therefore matches nothing, which is exactly the "stale ignore"
// shape assertNoOverflow's own throw-if-zero guard is designed to catch (and
// did, the first time this ran for real). The container selector below
// targets the wrapper directly and by structure (its `overflow-hidden
// rounded-lg` class combo alone is NOT unique on this page — 6 other cards
// share it — so `:has()` pins it to the one that also directly contains the
// pipeline strip's own `grid grid-cols-5 divide-x` row).
const DASHBOARD_PIPELINE_STRIP_CONTAINER = [
  ".overflow-hidden.rounded-lg:has(> .grid.grid-cols-5.divide-x)",
];

const VIEWPORTS = [
  { width: 390, height: 844, label: "390" },
  { width: 768, height: 1024, label: "768" },
  { width: 1440, height: 900, label: "1440" },
] as const;

/** Opens the header notification bell and asserts the portaled dropdown
 * itself never escapes the viewport — the probe walks `body *` so it already
 * covers this, but asserting the dropdown's own bounding box by name makes a
 * regression here diagnosable at a glance rather than buried in a 5-offender
 * list.
 *
 * `ignoreContainer`, when given, is forwarded to this call's own
 * assertNoOverflow — found necessary running this for real: opening the
 * dropdown doesn't navigate away, so whatever page it was opened ON (here,
 * the dashboard) is still underneath it, pipeline-strip clip defect and all.
 * The main dashboard assertNoOverflow call ignoring that defect doesn't
 * carry over to this SEPARATE call on the same still-rendered page — each
 * assertNoOverflow call is independent, so each needs to be told.
 */
async function assertNotificationDropdownContained(
  page: Page,
  screenLabel: string,
  ignoreContainer?: string[],
) {
  const bell = page.getByRole("button", { name: /notification/i });
  if ((await bell.count()) === 0) return; // not present on every screen's header state
  await bell.first().click();
  const panel = page.getByText("Notifications", { exact: true }).first();
  await expect(panel).toBeVisible({ timeout: 5_000 });
  await assertNoOverflow(
    page,
    `${screenLabel} — notifications dropdown open`,
    undefined,
    ignoreContainer,
  );
  // Close it so it doesn't shadow the next screen's own interactions.
  await page.keyboard.press("Escape");
}

for (const vp of VIEWPORTS) {
  test.describe(`operator dashboard — ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`no element exceeds the viewport across the owner's operator pages (${vp.label}px)`, async ({
      page,
    }) => {
      test.setTimeout(180_000);

      // ── Dashboard home + notification dropdown ──────────────────────────
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible({
        timeout: 15_000,
      });
      // Wait for the order-pipeline strip's own data, not just the page
      // shell — it renders conditionally on `!ordersLoading`
      // ((dashboard)/dashboard/page.tsx:787), so a heading-only wait can
      // still measure a loading skeleton instead of the real layout.
      // Found running this for real, twice: (1) a bare getByText("Pending")
      // is a strict-mode violation — the same word also renders as an
      // order-status BADGE elsewhere on the page (a recent-orders list),
      // which isn't a link, so scoping by role fixes that. (2) exact: true
      // then failed outright — the link's accessible name concatenates BOTH
      // its child spans (dashboard/page.tsx:825-833: the count span plus the
      // label span), so it's actually "2 Pending"/"0 Pending"/etc, never the
      // bare word. A non-exact, case-insensitive match is what's needed —
      // it's also exactly what Playwright's own strict-mode error suggested
      // the first time ("aka getByRole('link', { name: 'Pending' })", no
      // `exact`), which this branch initially over-corrected past.
      await expect(page.getByRole("link", { name: /pending/i })).toBeVisible({
        timeout: 15_000,
      });
      await assertNoOverflow(
        page,
        "dashboard",
        undefined,
        vp.width === 390 ? DASHBOARD_PIPELINE_STRIP_CONTAINER : undefined,
      );
      expect(await documentLevelOverflowPx(page)).toBeLessThanOrEqual(0);
      await assertNotificationDropdownContained(
        page,
        "dashboard",
        vp.width === 390 ? DASHBOARD_PIPELINE_STRIP_CONTAINER : undefined,
      );

      // ── Orders list ──────────────────────────────────────────────────────
      await page.goto("/orders");
      await expect(page.getByRole("button", { name: "New Order" })).toBeVisible({
        timeout: 15_000,
      });
      // "New Order" is the static toolbar, present before data ever loads —
      // not proof the table itself finished loading (see waitForDataLoaded).
      await waitForDataLoaded(page);
      await assertNoOverflow(page, "orders (list)");

      // ── Order detail (real navigation through the list, not a side-channel
      // API call). The row itself has no <a href> — it's a button, not a
      // link (`aria-label="View order details"` in orders/page.tsx) — an
      // `a[href^=...]` locator here would always match 0 and silently skip
      // this whole check without ever failing. Asserted, not skipped: a
      // seeded order is a baseline fixture on the e2e-routeflow tenant.
      await expect(
        page.getByRole("button", { name: "View order details" }).first(),
        "no seeded order on the e2e-routeflow tenant to open — check the seed",
      ).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: "View order details" }).first().click();
      // Explicit URL proof, not just content visibility — a click landing on
      // the wrong element or a navigation that silently no-ops could still
      // leave *some* matching text on screen; the URL is the one thing that
      // can't lie about whether we actually reached the detail page.
      await page.waitForURL(/\/orders\/[^/]+$/, { timeout: 15_000 });
      // getByText(/line items/i) is ambiguous on this page — it also matches
      // the summary panel's <dt>Line items</dt> term, not just this heading.
      // Only surfaced once real navigation actually happened for the first
      // time (this branch's earlier locator bug meant it never had before).
      await expect(page.getByRole("heading", { name: "Line Items" })).toBeVisible({
        timeout: 15_000,
      });
      await assertNoOverflow(page, "orders/[id]");
      expect(await documentLevelOverflowPx(page)).toBeLessThanOrEqual(0);

      // ── Customers list — B749 ignored, only at 390 (see header) ─────────
      // At 768/1440 there's room for the toolbar and no ignore is applied,
      // so a regression there still fails.
      await page.goto("/customers");
      await waitForDataLoaded(page);
      await assertNoOverflow(
        page,
        "customers (list)",
        vp.width === 390 ? isB749Toolbar : undefined,
      );

      // ── Products list ────────────────────────────────────────────────────
      await page.goto("/products");
      await waitForDataLoaded(page);
      await assertNoOverflow(page, "products (list)");

      // ── Invoices list — B750 (table) + the newly-found toolbar overflow
      // ignored, only at 390 (see header) ─────────────────────────────────
      await page.goto("/invoices");
      await waitForDataLoaded(page);
      await assertNoOverflow(
        page,
        "invoices (list)",
        vp.width === 390 ? isInvoicesToolbar : undefined,
        vp.width === 390 ? B750_TABLE_CONTAINER : undefined,
      );

      // ── Routes list ──────────────────────────────────────────────────────
      await page.goto("/routes");
      await waitForDataLoaded(page);
      await assertNoOverflow(page, "routes (list)");

      // ── Settings ─────────────────────────────────────────────────────────
      await page.goto("/settings");
      await waitForDataLoaded(page);
      await assertNoOverflow(page, "settings");
      expect(await documentLevelOverflowPx(page)).toBeLessThanOrEqual(0);
    });
  });
}

test.describe("operator dashboard — notification dropdown clamp at 280px", () => {
  // 280, not one of the three standard widths above: the dropdown's own
  // natural width is w-80 (320px). At 390/768/1440, and even at exactly
  // 320px, Radix's built-in collision avoidance can reposition the panel to
  // stay on screen without needing the max-w-[calc(100vw-2rem)] clamp this
  // batch added — repositioning alone can't help once the viewport is
  // narrower than the panel's own natural width, so 280 is the width where
  // this test can actually tell the clamp apart from Radix's own behavior.
  // At 280px, max-w-[calc(100vw-2rem)] computes to 248px (< 320px) — the
  // panel MUST shrink to fit, proving the clamp is doing real work.
  test.use({ viewport: { width: 280, height: 844 } });

  test("the portaled dropdown itself never exceeds a viewport narrower than its own natural width", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    // Not the page-title heading here — at 280px (narrower than any real
    // device, deliberately, to isolate the clamp from Radix's own collision
    // avoidance) the header hides it for space, real app behavior unrelated
    // to this test. Wait on the one element this test actually needs.
    const bell = page.getByRole("button", { name: /notification/i });
    await expect(bell.first()).toBeVisible({ timeout: 15_000 });
    await bell.first().click();
    const panel = page.getByText("Notifications", { exact: true }).first();
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // Direct check on the dropdown's own box (Radix's DropdownMenu.Content
    // renders role="menu") — the one element this test exists to prove.
    // Deliberately NOT the general page-wide assertNoOverflow probe here:
    // 280px is an intentionally extreme, non-target width chosen only to
    // isolate the clamp from Radix's own collision avoidance (see above) —
    // it is not one of the PR's real target viewports (390/768/1440), and a
    // whole-page sweep at it surfaces genuinely unrelated overflow (e.g. the
    // dashboard's own "New Order/Route/Invoice" quick-action row, which
    // nobody has claimed needs to fit in 280px). Scoping to the dropdown's
    // own box keeps this test honest about what it actually checks.
    const menuBox = await page.getByRole("menu").boundingBox();
    expect(menuBox, "notification menu did not render").not.toBeNull();
    expect(menuBox!.x).toBeGreaterThanOrEqual(0);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(280);
  });
});
