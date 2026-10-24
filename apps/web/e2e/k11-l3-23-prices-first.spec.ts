/**
 * K11-23 (prior F28): prices on the first phone screen, at 1440 / 768 / 390, flag ON and flag OFF.
 *   390 and 768: after load, the "Price per ..." label's top is inside the first screen; the Tab order follows
 *   what is on screen (tops never go backwards); Buyer merchandising ends the Details card.
 *   1440: two columns, the Image card on the left, Details on the right, starting on one line, with master's
 *   geometry: columns 1/3 and 2/3 of the grid with a 24 px gap, and 20 px from Details to the next card. Run again
 *   with 3 photos on a throwaway product.
 *
 * "Within 1 px of master" is asserted as master's grid arithmetic (grid-cols-3, gap-6, space-y-5), which the old
 * layout had too; the only box that differs from master is the merchandising block, which moved INSIDE Details.
 *
 * LOCAL LANE ONLY (project `units-v2`). Role: OPERATOR (staff, so merchandising is visible) on the approved test
 * tenant. Fixture E2E-FIX-UNITS (no photos) is read-only; the 3-photo case WRITES one throwaway product on the
 * approved test tenant only (assertTestTenant first), retired softly (inactive) in finally. The flag-OFF pass hides
 * `flag.units_prices_v2` from the browser only; the tenant must still serve it (the lane fails without it).
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { UNITS_V2_IDS } from "./helpers/units-v2-ids";
import { requireUnitsV2Flag } from "./helpers/units-v2-support";
import {
  BASE,
  VIEWPORTS,
  focusedPageTop,
  openFixtureProduct,
  seedImages,
  shot,
  viewportHeight,
} from "./k11-l3-support";

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

/** The two cards by test id (a class selector would also match the app shell's overflow-hidden wrappers). */
const card = (page: Page, heading: "Details" | "Image") =>
  page.getByTestId(heading === "Details" ? "product-details-card" : "product-image-card");

/** Master's two-column geometry at lg: Image 1/3, Details 2/3, 24 px between them, 20 px under Details. */
async function expectTwoColumns(page: Page) {
  const grid = (await page.locator("div.grid.lg\\:grid-cols-3").first().boundingBox())!;
  const colW = (grid.width - 2 * 24) / 3;
  const d = (await card(page, "Details").boundingBox())!;
  const i = (await card(page, "Image").boundingBox())!;
  expect(i.x, "Image is the left column").toBeCloseTo(grid.x, 0);
  expect(Math.abs(i.width - colW), "Image is one third").toBeLessThanOrEqual(1);
  expect(
    Math.abs(d.x - (grid.x + colW + 24)),
    "Details starts after a 24 px gap",
  ).toBeLessThanOrEqual(1);
  expect(Math.abs(d.width - (2 * colW + 24)), "Details is two thirds").toBeLessThanOrEqual(1);
  expect(Math.abs(i.y - d.y), "both columns start on one line").toBeLessThanOrEqual(1);
  // 20 px from Details to the next card in the right column (space-y-5, as on master)
  const next = (await page
    .getByTestId("product-lower-column")
    .locator(":scope > *")
    .first()
    .boundingBox())!;
  expect(Math.abs(next.y - (d.y + d.height) - 20), "20 px under Details").toBeLessThanOrEqual(1);
  expect(Math.abs(next.x - d.x), "the right column keeps its left edge").toBeLessThanOrEqual(1);
}

async function expectPhoneOrder(page: Page, flagOff: boolean) {
  // flag OFF: the old "Price per ..." row. flag ON: the Details price line is gone (R3 say-no 2), so the prices grid is the price home.
  if (!flagOff) await expect(page.getByTestId("details-price-line")).toHaveCount(0);
  const label = flagOff
    ? page.getByText(/^Price per /).first()
    : page.getByTestId(UNITS_V2_IDS.grid);
  const top = (await label.boundingBox())!.y;
  expect(top, "the price label is on the first screen").toBeLessThan(viewportHeight(page));
  if (!flagOff) {
    // The grid's top alone is too loose (More details collapsed, it passed with the "Prices by unit" heading at
    // y=874 and the first figure at y=1012 on a 844 px screen). Both the region heading AND the first money figure
    // in the grid must start on the first screen.
    const hTop = (await page.getByTestId("units-v2-h-units").boundingBox())!.y;
    expect(hTop, "the Prices by unit heading is on the first screen").toBeLessThan(
      viewportHeight(page),
    );
    // A RegExp, not a `:text-matches("...")` string: the selector parser unescapes `\d` and `\$` inside its quoted
    // argument, so that probe never matched anything.
    const figure = page
      .getByTestId(UNITS_V2_IDS.grid)
      .getByText(/^\$[\d,]+\.\d{2}$/)
      .filter({ visible: true })
      .first();
    await expect(figure, "the grid shows a money figure").toBeVisible();
    const fTop = (await figure.boundingBox())!.y;
    expect(fTop, "the first money figure in the grid is on the first screen").toBeLessThan(
      viewportHeight(page),
    );
  }
  const d = (await card(page, "Details").boundingBox())!;
  const i = (await card(page, "Image").boundingBox())!;
  expect(d.y, "Details comes before Image").toBeLessThan(i.y);

  // Tab through the first controls inside the page content: each stop is at or below the previous one (reading
  // order = tab order). Stops in the app header band are skipped, and same-row stops get a small tolerance band.
  await page.locator("h1#h-product").focus();
  let last = -1;
  let checked = 0;
  for (let n = 0; n < 14; n++) {
    await page.keyboard.press("Tab");
    const y = await focusedPageTop(page);
    if (y == null) continue;
    expect(y, `Tab stop ${n + 1} does not jump back up the page`).toBeGreaterThanOrEqual(last - 8);
    last = Math.max(last, y);
    checked++;
  }
  expect(checked, "the walk covered stops in the page content").toBeGreaterThan(3);
}

async function expectMerchLast(page: Page) {
  const details = card(page, "Details");
  // Below sm the secondary fields sit behind "More details" (hidden by CSS, still mounted); open it, then assert the
  // same things. From sm up the trigger is not shown and the fields are already visible.
  const more = page.getByTestId("details-more-toggle");
  if (await more.isVisible()) {
    await expect(page.getByTestId("details-more-panel"), "collapsed on a phone").toBeHidden();
    expect((await more.boundingBox())!.height, "a 44 px target").toBeGreaterThanOrEqual(44);
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
  }
  const merch = details.getByRole("heading", { name: "Buyer merchandising" });
  await expect(merch).toBeVisible();
  const m = (await merch.boundingBox())!;
  const desc = (await details.getByText("Description", { exact: true }).boundingBox())!;
  expect(m.y, "merchandising comes after Description").toBeGreaterThan(desc.y);
}

for (const flagOff of [false, true]) {
  for (const vp of VIEWPORTS) {
    test.describe(`K11-23 prices first, flag ${flagOff ? "OFF" : "ON"} @ ${vp.name}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });

      test("k11-l3 price label above the fold, tab order matches the screen, two columns at 1440", async ({
        page,
        context,
      }, info) => {
        await openFixtureProduct(page, context, undefined, { flagOff });
        // flag OFF: the jump strip is not there; flag ON: it is
        await expect(page.getByRole("navigation", { name: "On this page" })).toHaveCount(
          flagOff ? 0 : 1,
        );
        if (vp.width >= 1024) await expectTwoColumns(page);
        else await expectPhoneOrder(page, flagOff);
        await expectMerchLast(page);
        await shot(page, info, `k11-23-prices-first-flag-${flagOff ? "off" : "on"}`);
      });
    });
  }
}

test.describe("K11-23 three photos @ 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("k11-l3 two columns with the image on the left when the product has 3 photos", async ({
    page,
    context,
  }, info) => {
    assertTestTenant(TENANT_SLUG, "k11-23 three-photo fixture");
    await setTenantCookie(context, BASE);
    const ctx = await requireUnitsV2Flag(page);
    const created = await page.request.post(`${ctx.api}/products`, {
      headers: ctx.headers,
      data: {
        name: `QA K11 Photos ${Date.now().toString(36).toUpperCase()}`,
        unit: "each",
        pricePerUnit: "2.50",
      },
    });
    expect(created.ok(), `create the throwaway product: ${created.status()}`).toBeTruthy();
    const productId = ((await created.json()) as any).id as string;
    try {
      await seedImages(page, ctx, productId, 3);
      await openFixtureProduct(page, context, undefined, { productId });
      await expectTwoColumns(page);
      await expectMerchLast(page);
      await shot(page, info, "k11-23-three-photos-1440");
    } finally {
      const r = await page.request.patch(`${ctx.api}/products/${productId}`, {
        headers: ctx.headers,
        data: { isActive: false },
      });
      expect(r.ok(), `retire the throwaway product: ${r.status()}`).toBeTruthy();
    }
  });
});
