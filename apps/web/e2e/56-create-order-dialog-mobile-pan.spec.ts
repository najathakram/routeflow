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
 * viewport width. Fix: `app/globals.css` gains a global rule for
 * `input[type=date|time|datetime-local|month|week]` — `appearance: none`,
 * `box-sizing: border-box`, `min-width: 0`.
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
 * iOS Safari applies, as a page `<style>` tag, before measuring. Without the
 * injection this spec cannot fail even on pre-fix code — plain Chromium's
 * own date-input box model was never broken — so the injection is what
 * makes this a genuine red-first proof rather than a test that can never
 * fail. NOT independently run from this session: no Docker/Playwright
 * access here — this needs to be run against both `origin/master` (expected
 * FAIL) and this branch (expected PASS) before landing.
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
 * trips). Injected as an authored `<style>` so it applies in plain Chromium
 * too; the app's own `appearance-none` rule (globals.css) must override this
 * exact declaration for the fix to hold.
 */
const IOS_DATE_INPUT_QUIRK_CSS = `
  input[type="date"] {
    -webkit-appearance: menulist-button;
    padding: 0 0.5em;
    box-sizing: content-box;
  }
`;

const DIALOG_BODY_SELECTOR = 'form[class*="overflow-y-auto"]';

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
      // Injected BEFORE navigation so it's present the instant the date inputs
      // mount — matches iOS Safari's own UA stylesheet, which is never "added
      // late" either.
      await page.addStyleTag({ content: IOS_DATE_INPUT_QUIRK_CSS });

      await openBuilderWithRealisticCart(page);
      await expect(page.locator("#delivery-date")).toBeVisible();
      await expect(page.locator("#order-date")).toBeVisible();

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
 */
test.describe("create-order dialog — boxed line qty column at 320px", () => {
  test.use({ viewport: { width: 320, height: 690 } });

  test("the boxed qty-controls column fits its grid track at 320px (not #2080)", async ({
    page,
  }) => {
    await openBuilderWithRealisticCart(page);

    const qtyColumn = page.locator("li").filter({ hasText: "cases" }).locator("div").first();
    const box = await qtyColumn.boundingBox();
    expect(box, "boxed qty-controls column not found").not.toBeNull();

    const listItem = page.locator("li").filter({ hasText: "cases" }).first();
    const listBox = await listItem.boundingBox();
    expect(listBox, "cart row not found").not.toBeNull();

    if (box && listBox) {
      expect(
        box.x + box.width,
        `qty-controls column's right edge (${box.x + box.width}) escapes its row (right edge ${listBox.x + listBox.width}) at 320px`,
      ).toBeLessThanOrEqual(listBox.x + listBox.width + 1);
    }
  });
});
