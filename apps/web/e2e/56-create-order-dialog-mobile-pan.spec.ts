/**
 * #2080 (P0, owner-reported production bug, iPhone). The staff order dialog's
 * own scroll body (`CreateOrderModal.tsx`, `max-h-[65vh] overflow-y-auto pr-1`)
 * sets only the y axis, so overflow-x computes to `auto` too (CSS Overflow
 * spec axis-pairing — the same shell-level quirk #1288/B559 fixed at the page
 * level, never touching this dialog). A boxed line's qty-controls column
 * (`LineItemRow.tsx`) carried a hard `min-w-[190px]` floor plus two un-wrapped
 * inner flex rows (the case/pieces inputs) — together wide enough at 390px
 * that the dialog body was a few px wider than the viewport, and a vertical
 * swipe on iOS Safari panned it sideways: section labels lost their first
 * letters ("USTOMER", "RODUCTS"), cards and totals clipped on the left.
 *
 * Fix: `min-w-0 sm:min-w-[190px]` (the column can shrink below `sm`, keeping
 * desktop unchanged) + `flex-wrap` on both inner input rows (root cause), plus
 * `overflow-x-hidden` paired onto the scroll body (backstop only, matching
 * #1288's established pattern — never the fix by itself).
 *
 * Reuses #1288's shared element-level overflow walk
 * (`e2e/helpers/overflow.ts`, copied byte-identical from that unmerged branch
 * per the issue's own note — this file is NOT edited here) rather than the
 * legacy `documentElement.scrollWidth` check, which is structurally blind to
 * overflow absorbed by an inner `overflow-y:auto` container (see that
 * helper's own header) — exactly this dialog's shape.
 *
 * Targets the one seeded boxed product (`e2e-seed.js` FIXTURE_PRODUCTS,
 * `unitsPerBox: 12`) so BOTH of LineItemRow's case/unit input rows render —
 * the exact branch this fix touches. Read-only up to the point of adding one
 * line; the order is never submitted (no fixture cleanup needed).
 */
import { test, expect, type Page } from "@playwright/test";
import { findViewportOverflow } from "./helpers/overflow";

const VIEWPORTS = [
  { width: 320, height: 690, label: "320" },
  { width: 375, height: 812, label: "375" },
  { width: 390, height: 844, label: "390" },
  { width: 430, height: 932, label: "430" },
] as const;

async function openBuilderWithBoxedLine(page: Page) {
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

  // The one seeded boxed product — carries unitsPerBox, so LineItemRow
  // renders the Case/Unit toggle + case+pieces inputs this fix targets.
  const productSearch = page.getByPlaceholder("Search by name, SKU or scan barcode…");
  await productSearch.fill("E2E Fixture Boxed Case");
  await page
    .locator('input[placeholder="Search by name, SKU or scan barcode…"] ~ ul li button')
    .first()
    .click({ timeout: 10_000 });

  return title;
}

for (const vp of VIEWPORTS) {
  test.describe(`create-order dialog — ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`no element escapes the viewport with a boxed line in the cart (${vp.label}px)`, async ({
      page,
    }) => {
      await openBuilderWithBoxedLine(page);

      // Exercise BOTH sellBy branches (case+pieces, then unit) — either can
      // independently overflow before the fix, since both inner rows lacked
      // flex-wrap.
      const { offenders: caseOffenders } = await findViewportOverflow(page);
      expect(
        caseOffenders,
        `viewport overflow (Case mode) at ${vp.label}px — ${JSON.stringify(caseOffenders.slice(0, 5))}`,
      ).toHaveLength(0);

      await page.getByRole("button", { name: "Unit", exact: true }).click();
      const { offenders: unitOffenders } = await findViewportOverflow(page);
      expect(
        unitOffenders,
        `viewport overflow (Unit mode) at ${vp.label}px — ${JSON.stringify(unitOffenders.slice(0, 5))}`,
      ).toHaveLength(0);
    });
  });
}
