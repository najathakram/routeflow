/**
 * #2080 (P0, owner-reported production bug, iPhone). The staff order dialog's
 * own scroll body (`CreateOrderModal.tsx`, `max-h-[65vh] overflow-y-auto`)
 * panned sideways on a vertical swipe.
 *
 * Root cause, per real device/emulated iOS measurement: the "Requested
 * Delivery Date" / "Order date" `<input type="date">`s (`:1856`, `:1869`)
 * are styled with Tailwind's `w-full`. iOS Safari gives a date input its own
 * menu-button chrome — forced `padding: 0 0.5em` and, for any non-pixel
 * width, `box-sizing: content-box` — so `w-full` renders at `100% + ~16px`
 * (up to +26px on newer iOS) of the actual available space, at EVERY
 * viewport width. Fix: `app/globals.css` gains a `:where()`-scoped rule for
 * `input[type=date|time|datetime-local|month|week]` — `appearance: none`,
 * `box-sizing: border-box`, plus a width floor (not `min-width: 0`, and a
 * `min-height` on `::-webkit-date-and-time-value` — see that file for why).
 *
 * `#1288`'s shared element-level overflow walk (`findViewportOverflow`) does
 * NOT catch this class of bug: its first pass only flags a box escaping the
 * viewport, its second only checks elements carrying an
 * `overflow-hidden`/`clip` class — a date input a few px too wide inside a
 * plain `overflow-y-auto` scroll body matches neither. This spec instead
 * asserts DIRECTLY on the dialog body's own `scrollWidth` vs `clientWidth` —
 * the same measurement iOS's own rendering makes real, and the one the
 * shared walk structurally can't perform for a sub-padding overflow like
 * this one.
 *
 * The `LineItemRow.tsx` boxed qty-controls column was investigated first (an
 * earlier commit on this branch, reverted) and is NOT part of this bug — it
 * sits inside `ul.overflow-hidden` and can't widen the dialog body. A
 * distinct, narrower, REAL 320px-only glitch in that same column (measured:
 * the `min-w-[190px]` floor runs 8px past the grid track's ~182px at 320px)
 * is pinned separately below, described as its own fix, not #2080.
 *
 * Reproduces the iOS-only date-input quirk in plain Chromium (no simulator
 * access from this session) by injecting the exact UA-stylesheet override
 * iOS Safari applies, as a page `<style>` tag — AFTER navigation (an
 * `addStyleTag` call before `page.goto` is discarded by the navigation, not
 * carried into the new document) and CONDITIONALLY: only when a date input's
 * OWN computed `appearance` is not already `none`, mirroring the real
 * cascade this bug depends on (iOS applies its forced chrome only where the
 * page hasn't already opted out of it) — on `origin/master` nothing sets
 * `appearance` on a date input, so the check is true and the quirk applies;
 * on this branch, `globals.css`'s own `appearance: none` already won, so the
 * check is false and the injected override is correctly inert. Without this
 * conditional the spec could either never fail (unconditional skip) or fail
 * even after the fix (unconditional inject with `!important`/higher
 * specificity) — Opus measured this exact form discriminating master (12px
 * overflow, fails) from this branch (0px, passes). NOT independently run
 * from this session: no Docker/Playwright access here — needs a live
 * red-on-`origin/master` / green-on-this-branch confirmation before landing.
 *
 * Seeds a cart approximating the owner's reported shape (`e2e-seed.js`
 * fixtures): the one boxed product (Case/Unit toggle + Case price input,
 * `unitsPerBox: 12`, long-ish name), a per-line note, and order-level
 * discount + shipping amounts. No regulated-category product fixture exists
 * in `e2e-seed.js` today (`LICENSED_TRACKED_CATEGORY_NAME` is seeded but not
 * assigned to any cart-addable product) — noted here rather than guessed at
 * with an unverifiable selector.
 */
import { test, expect, type Page } from "@playwright/test";
import { findViewportOverflow } from "./helpers/overflow";

const VIEWPORTS = [
  { width: 320, height: 690, label: "320" },
  { width: 375, height: 812, label: "375" },
  { width: 390, height: 844, label: "390" },
  { width: 430, height: 932, label: "430" },
] as const;

/**
 * iOS Safari's own UA stylesheet for `type="date"` (and siblings): forced
 * horizontal padding via its menu-button appearance, and content-box sizing
 * for any non-pixel width (the actual mechanism `w-full` — a percentage —
 * trips). No `!important` and no elevated specificity: on this branch the
 * app's own `globals.css` rule must be able to keep winning the cascade —
 * the CONDITIONAL injection below (only when nothing already opted out) is
 * what actually discriminates master from the fix, not this rule's own
 * strength.
 */
const IOS_DATE_INPUT_QUIRK_CSS = `
  input[type="date"] {
    -webkit-appearance: menulist-button;
    padding: 0 0.5em;
    box-sizing: content-box;
  }
`;

const DIALOG_BODY_SELECTOR = 'form[class*="overflow-y-auto"]';

/**
 * Simulates iOS Safari's UA-stylesheet override for date inputs, but only
 * when nothing on the page has already opted a date input out of it (i.e.
 * its own computed `appearance` isn't already `none`) — see the module
 * header for why this conditional, not the override's own CSS strength, is
 * what makes this spec discriminate master from the fix.
 */
async function maybeSimulateIosDateInputChrome(page: Page) {
  const needsSimulation = await page.evaluate(() => {
    const input = document.querySelector('input[type="date"]');
    if (!input) return false;
    const computed = getComputedStyle(input).appearance;
    return computed !== "none";
  });
  if (needsSimulation) {
    await page.addStyleTag({ content: IOS_DATE_INPUT_QUIRK_CSS });
  }
  return needsSimulation;
}

async function openBuilderWithRealisticCart(page: Page) {
  await page.goto("/orders");
  await page
    .getByRole("button", { name: /new order/i })
    .first()
    .click();
  const title = page.getByRole("heading", { name: "Create Order" });
  await expect(title).toBeVisible({ timeout: 10_000 });

  // Same seeded-customer pattern as spec 08 (openBuilderWithCustomer).
  await page.getByPlaceholder("Search by business name…").fill("E2E Fixture Deli Three");
  await page
    .locator('input[placeholder="Search by business name…"] ~ ul li button')
    .first()
    .click({ timeout: 10_000 });

  // The one seeded boxed product — Case/Unit toggle, cases+units inputs,
  // Case price input, and a name long enough to stress-test the row.
  const productSearch = page.getByPlaceholder("Search by name, SKU or scan barcode…");
  await productSearch.fill("E2E Fixture Boxed Case");
  await page
    .locator('input[placeholder="Search by name, SKU or scan barcode…"] ~ ul li button')
    .first()
    .click({ timeout: 10_000 });

  // Per-line note (StickyNote icon toggle on the just-added row).
  await page.getByTitle("Add flavor / note").first().click();
  await page
    .getByPlaceholder(/flavor or note for this item/i)
    .first()
    .fill("Deliver to the back dock — buzzer is broken, call on arrival");

  // Order-level discount + shipping — both render once the cart is non-empty.
  await page.getByLabel("Order discount").fill("5.00");
  await page.getByLabel("Shipping fee").fill("12.50");

  return title;
}

async function bodyScrollOverflowPx(page: Page): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return NaN;
    return el.scrollWidth - el.clientWidth;
  }, DIALOG_BODY_SELECTOR);
}

for (const vp of VIEWPORTS) {
  test.describe(`create-order dialog — ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`dialog body has no scrollWidth/clientWidth overflow with the iOS date-input quirk simulated (${vp.label}px)`, async ({
      page,
    }) => {
      await openBuilderWithRealisticCart(page);
      await expect(page.locator("#delivery-date")).toBeVisible();
      await expect(page.locator("#order-date")).toBeVisible();

      // AFTER navigation, and only when applicable — see module header.
      const simulated = await maybeSimulateIosDateInputChrome(page);
      expect(
        simulated,
        "the iOS chrome simulation never applied (a date input's computed appearance was " +
          "already 'none') — this run proves nothing about the bug it targets",
      ).toBe(true);

      // The DIRECT measurement — not the shared element-walk, which cannot
      // see this class of overflow (see module header).
      const overflowPx = await bodyScrollOverflowPx(page);
      expect(
        overflowPx,
        `dialog body scrollWidth exceeds clientWidth by ${overflowPx}px at ${vp.label}px ` +
          `with the iOS date-input quirk simulated — this is the owner's reported sideways pan`,
      ).toBeLessThanOrEqual(0);

      // Belt-and-braces: the shared walk still shouldn't find anything else new.
      const { offenders } = await findViewportOverflow(page);
      expect(
        offenders,
        `viewport overflow (shared walk) at ${vp.label}px — ${offenders.length} offender(s), worst: ${JSON.stringify(offenders.slice(0, 5))}`,
      ).toHaveLength(0);
    });
  });
}

/**
 * A distinct, narrower, REAL bug from the one above — measured separately:
 * at 320px the boxed qty-controls column's `min-w-[190px]` floor runs 8px
 * past the grid track's own ~182px available width (`grid-cols-[minmax(0,1fr)_auto]`
 * resolving column 1 that tight at this specific viewport). NOT #2080 — this
 * column sits inside `ul.overflow-hidden` and can't widen the dialog body,
 * so it never caused the owner's report; it's its own, real, 320px-only
 * clip inside that list. Fix: `min-w-0 sm:min-w-[190px]` on that column
 * (`LineItemRow.tsx`) — shrinks below `sm`, unchanged at/above it.
 *
 * Located via `data-testid`s (`line-qty-controls`, `line-actions-column`),
 * not a text-content filter — the row's own product-info column also
 * contains "cases" text (the "1 case = N units" caption), so a `hasText`
 * filter without a testid finds the WRONG column (219 of 292px, never the
 * qty-controls one) and pins nothing (L-212: a selector that silently
 * matches the wrong element is worse than one that matches zero). Measures
 * against the grid track's own right boundary — `line-actions-column`'s
 * (column 2, same row) left edge minus the row's `gap-x-2` (8px) — not the
 * row's own right edge, which the qty column can't reach regardless (column
 * 2 sits between it and the row's edge).
 */
test.describe("create-order dialog — boxed line qty column at 320px", () => {
  test.use({ viewport: { width: 320, height: 690 } });

  test("the boxed qty-controls column fits its grid track at 320px (not #2080)", async ({
    page,
  }) => {
    await openBuilderWithRealisticCart(page);

    const qtyColumn = page.getByTestId("line-qty-controls").first();
    const actionsColumn = page.getByTestId("line-actions-column").first();

    const qtyBox = await qtyColumn.boundingBox();
    const actionsBox = await actionsColumn.boundingBox();
    expect(qtyBox, "line-qty-controls not found").not.toBeNull();
    expect(actionsBox, "line-actions-column not found").not.toBeNull();

    if (qtyBox && actionsBox) {
      const GAP_X_PX = 8; // Tailwind's gap-x-2
      const trackRightBoundary = actionsBox.x - GAP_X_PX;
      expect(
        qtyBox.x + qtyBox.width,
        `qty-controls column's right edge (${qtyBox.x + qtyBox.width}) escapes its grid ` +
          `track's right boundary (${trackRightBoundary}) at 320px`,
      ).toBeLessThanOrEqual(trackRightBoundary + 1);
    }
  });
});
