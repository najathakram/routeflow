/**
 * Operator dashboard mobile overflow — owner report, spec 53.
 *
 * The owner reported that on a phone browser nearly every page drifts
 * horizontally on a vertical swipe, and after pinch-zooming the page does not
 * settle back to full width. Root cause (see apps/web/app/globals.css's new
 * `html { overflow-x: clip }` rule and this shell's own layout.tsx): every
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
 * customers (B749, matched by its "New Customer" button text) and an
 * unwrapped table on invoices (B750, matched by table-family tags). Narrowed
 * this way rather than excluded outright, so a regression anywhere else on
 * either page still fails. See isB749Toolbar/isB750Table below.
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
import { assertNoOverflow, documentLevelOverflowPx, type Offender } from "./helpers/overflow";

// B749: the customers-list toolbar's "New Customer" button group has no wrap
// and overflows at 390. Matched by text rather than class — the offending
// classes (`shrink-0`, `flex items-center gap-2`) are generic Tailwind
// utilities shared all over the app; the toolbar's own button labels are the
// stable thing to match on this specific page.
const isB749Toolbar = (o: Offender) => o.text.includes("New Customer");

// B750: the invoices-list table has no scroll wrapper at all and overflows at
// 390. Matched by tag — on this page, any TABLE-family element escaping the
// viewport IS this bug; nothing else on the page renders those tags.
const TABLE_TAGS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD"]);
const isB750Table = (o: Offender) => TABLE_TAGS.has(o.tag);

const VIEWPORTS = [
  { width: 390, height: 844, label: "390" },
  { width: 768, height: 1024, label: "768" },
  { width: 1440, height: 900, label: "1440" },
] as const;

/** Opens the header notification bell and asserts the portaled dropdown
 * itself never escapes the viewport — the probe walks `body *` so it already
 * covers this, but asserting the dropdown's own bounding box by name makes a
 * regression here diagnosable at a glance rather than buried in a 5-offender
 * list. */
async function assertNotificationDropdownContained(page: Page, screenLabel: string) {
  const bell = page.getByRole("button", { name: /notification/i });
  if ((await bell.count()) === 0) return; // not present on every screen's header state
  await bell.first().click();
  const panel = page.getByText("Notifications", { exact: true }).first();
  await expect(panel).toBeVisible({ timeout: 5_000 });
  await assertNoOverflow(page, `${screenLabel} — notifications dropdown open`);
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
      await assertNoOverflow(page, "dashboard");
      expect(await documentLevelOverflowPx(page)).toBeLessThanOrEqual(0);
      await assertNotificationDropdownContained(page, "dashboard");

      // ── Orders list ──────────────────────────────────────────────────────
      await page.goto("/orders");
      await expect(page.getByRole("button", { name: "New Order" })).toBeVisible({
        timeout: 15_000,
      });
      await assertNoOverflow(page, "orders (list)");

      // ── Order detail (real navigation through the list, not a side-channel
      // API call) — only if a seeded order exists. ────────────────────────
      const firstOrderLink = page.locator('a[href^="/orders/"]').first();
      if (await firstOrderLink.count()) {
        await firstOrderLink.click();
        await expect(page.getByText(/line items/i)).toBeVisible({ timeout: 15_000 });
        await assertNoOverflow(page, "orders/[id]");
        expect(await documentLevelOverflowPx(page)).toBeLessThanOrEqual(0);
      }

      // ── Customers list — B749 ignored, only at 390 (see header) ─────────
      // At 768/1440 there's room for the toolbar and no ignore is applied,
      // so a regression there still fails.
      await page.goto("/customers");
      await assertNoOverflow(
        page,
        "customers (list)",
        vp.width === 390 ? isB749Toolbar : undefined,
      );

      // ── Products list ────────────────────────────────────────────────────
      await page.goto("/products");
      await assertNoOverflow(page, "products (list)");

      // ── Invoices list — B750 ignored, only at 390 (see header) ──────────
      await page.goto("/invoices");
      await assertNoOverflow(page, "invoices (list)", vp.width === 390 ? isB750Table : undefined);

      // ── Routes list ──────────────────────────────────────────────────────
      await page.goto("/routes");
      await assertNoOverflow(page, "routes (list)");

      // ── Settings ─────────────────────────────────────────────────────────
      await page.goto("/settings");
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
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible({
      timeout: 15_000,
    });
    const bell = page.getByRole("button", { name: /notification/i });
    await bell.first().click();
    const panel = page.getByText("Notifications", { exact: true }).first();
    await expect(panel).toBeVisible({ timeout: 5_000 });
    await assertNoOverflow(page, "dashboard — notifications dropdown open at 280px");
  });
});
