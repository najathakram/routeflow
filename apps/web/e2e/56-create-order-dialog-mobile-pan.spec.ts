/**
 * #2080 (P0, owner-reported production bug, iPhone). The staff order dialog's
 * own scroll body (`CreateOrderModal.tsx`, `max-h-[65vh] overflow-y-auto`)
 * panned sideways on a vertical swipe. Root cause, per real device/emulated
 * measurement (NOT reproducible in plain Chromium, which is why it went
 * unreproduced locally for as long as it did): the "Requested Delivery Date"
 * / "Order date" `<input type="date">`s (`:1856`, `:1869`) are styled with
 * Tailwind's `w-full`. iOS Safari gives a date input its own menu-button
 * chrome — forced `padding: 0 0.5em` and, for any non-pixel width,
 * `box-sizing: content-box` — so `w-full` renders at `100% + ~16px`
 * (measured up to +26px on newer iOS) of the actual available space, at
 * EVERY viewport width. That's the owner's exact symptom (section labels
 * losing their first letters, cards/totals clipping left): the dialog body
 * was a few px wider than the viewport the whole time a date input was on
 * screen, which is always, once a customer is picked.
 *
 * `LineItemRow.tsx`'s boxed qty-controls column was investigated first (an
 * earlier commit on this branch, reverted) — it sits inside `ul.overflow-hidden`
 * and can't widen the dialog body regardless of its own width, so it was
 * never the cause. `overflow-x-hidden` on the scroll body was also
 * considered and dropped: it would have masked the real 12px+ overflow by
 * clipping the date inputs themselves, rather than fixing them.
 *
 * Fix (globals.css, not scoped to this one dialog — apps/web has 94
 * `type="date"` inputs total): `appearance: none` opts every date/time input
 * back into standard box-model sizing, `box-sizing: border-box` makes that
 * explicit, `min-width: 0` lets one still shrink inside a flex/grid parent.
 *
 * This spec reproduces the iOS-only quirk in plain Chromium (no iOS
 * simulator access from this session) by INJECTING the exact UA-stylesheet
 * override iOS Safari applies to date/time inputs as a page style tag,
 * before asserting via #1288's shared element-level overflow walk
 * (`e2e/helpers/overflow.ts`, copied byte-identical from that unmerged
 * branch). Without the injected override this spec cannot fail even on
 * pre-fix code — plain Chromium's own date-input box model was never broken
 * — so the override is the thing that makes this a genuine red-first proof
 * rather than a false-negative test that always passes.
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

async function openBuilderWithCustomer(page: Page) {
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

  return title;
}

for (const vp of VIEWPORTS) {
  test.describe(`create-order dialog — ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`no element escapes the viewport with the iOS date-input quirk simulated (${vp.label}px)`, async ({
      page,
    }) => {
      // Injected BEFORE navigation so it's present the instant the date inputs
      // mount — matches iOS Safari's own UA stylesheet, which is never "added
      // late" either.
      await page.addStyleTag({ content: IOS_DATE_INPUT_QUIRK_CSS });

      await openBuilderWithCustomer(page);
      await expect(page.locator("#delivery-date")).toBeVisible();
      await expect(page.locator("#order-date")).toBeVisible();

      const { offenders } = await findViewportOverflow(page);
      expect(
        offenders,
        `viewport overflow (iOS date-input quirk simulated) at ${vp.label}px — ${offenders.length} offender(s), worst: ${JSON.stringify(offenders.slice(0, 5))}`,
      ).toHaveLength(0);
    });
  });
}
