/**
 * K11 lane L1, navigation cards, proven in a real browser at 1440 / 768 / 390.
 *   K11-01  the jump strip lands clear of itself: the heading sits under the strip's bottom edge, the first grid
 *           row (or phone card) is fully in view, and the Customer view's search field is in view
 *   K11-02  at 390 the strip needs no horizontal swipe and shows the short labels; wider widths keep the full ones
 *   K11-03  a jump writes the hash (query kept, no history entry) and a reload comes back to that section
 *
 * NOT RUN where it was written (no browser, no Docker in that tree). It is the Playwright half of the three cards'
 * acceptance; the Jest half is nav/ProductJumpLinks.settle.test.tsx and ProductJumpLinks.test.tsx.
 *
 * LOCAL LANE ONLY (project `units-v2`). READ-ONLY: nothing is saved. Role: OPERATOR on the approved test tenant;
 * fixture product E2E-FIX-UNITS (apps/api/scripts/e2e-seed.js). A tenant not served `flag.units_prices_v2` FAILS.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const SKU = "E2E-FIX-UNITS";
const STRIP = "units-v2-jump";
const link = (id: string) => `units-v2-jump-${id}`;
/** One 8px clearance under the strip, plus a pixel of rounding. */
const SLACK = 2;

async function openProduct(page: Page, context: Parameters<typeof setTenantCookie>[0]) {
  await setTenantCookie(context, BASE);
  const ctx = await requireUnitsV2Flag(page);
  const product = await productBySku(page, ctx, SKU);
  await page.goto(`/products/${product.id}`);
  await expect(page.getByTestId("units-v2-grid")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId(STRIP)).toBeVisible();
  return { ...ctx, productId: product.id };
}

/** The box of a test id or element id; fails loudly when it is not there. */
async function boxOf(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  expect(b, `${selector} has a box`).toBeTruthy();
  return b!;
}

/** Wait until the page has stopped scrolling (the smooth scroll and the one settle re-scroll are done). */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const main = document.getElementById("main-content")!;
        let last = main.scrollTop;
        let still = 0;
        const tick = () => {
          still = main.scrollTop === last ? still + 1 : 0;
          last = main.scrollTop;
          if (still >= 12) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

for (const vp of VIEWPORTS) {
  test.describe(`K11 L1 navigation @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("K11-01: Units and prices lands under the strip with the first row in view", async ({
      page,
      context,
    }, info) => {
      await openProduct(page, context);
      await page.getByTestId(link("h-units")).click();
      await settle(page);
      const strip = await boxOf(page, `[data-testid="${STRIP}"]`);
      const heading = await boxOf(page, "#units-v2-grid-title");
      expect(heading.y, "the heading is not under the strip").toBeGreaterThanOrEqual(
        strip.y + strip.height - SLACK,
      );
      const vh = page.viewportSize()!.height;
      const firstRow = await boxOf(
        page,
        vp.cards
          ? '[data-testid^="units-v2-card"]'
          : '[data-testid="units-v2-units-table"] tbody tr',
      );
      expect(
        firstRow.y + firstRow.height,
        "the first grid row is fully in view",
      ).toBeLessThanOrEqual(vh);
      await shot(page, info, `k11-01-units-${vp.name}`);
    });

    test("K11-01: Customer view lands with its search field in view", async ({
      page,
      context,
    }, info) => {
      await openProduct(page, context);
      const cust = page.getByTestId(link("h-cust"));
      await expect(cust).toBeVisible({ timeout: 20_000 });
      await cust.click();
      await settle(page);
      const strip = await boxOf(page, `[data-testid="${STRIP}"]`);
      const search = await boxOf(page, "#units-v2-cust-search");
      const vh = page.viewportSize()!.height;
      expect(search.y, "the search field is not under the strip").toBeGreaterThanOrEqual(
        strip.y + strip.height - SLACK,
      );
      expect(search.y + search.height, "the search field is fully in view").toBeLessThanOrEqual(vh);
      await shot(page, info, `k11-01-customer-${vp.name}`);
    });

    test("K11-02: the strip fits the row at 390 and shows full labels from sm up", async ({
      page,
      context,
    }, info) => {
      await openProduct(page, context);
      const strip = page.getByTestId("units-v2-jump-strip");
      const fits = await strip.evaluate((el) => el.scrollWidth <= el.clientWidth);
      const first = page.getByTestId(link("h-product"));
      const units = page.getByTestId(link("h-units"));
      if (vp.width < 640) {
        expect(fits, "no horizontal swipe is needed at 390").toBe(true);
        for (const id of ["h-product", "h-units", "h-cust", "h-sales"]) {
          const b = await page.getByTestId(link(id)).boundingBox();
          if (!b) continue; // a section the product does not have
          expect(b.x + b.width, `${id} is inside the viewport`).toBeLessThanOrEqual(vp.width);
        }
        await expect(units).toHaveText("Prices");
      } else {
        await expect(units).toHaveText("Units and prices");
      }
      await expect(units).toHaveAttribute("aria-label", "Units and prices");
      await expect(first).toHaveAttribute("aria-label", "Product");
      await shot(page, info, `k11-02-strip-${vp.name}`);
    });

    test("K11-03: a jump writes the hash and a reload comes back to it", async ({
      page,
      context,
    }, info) => {
      await openProduct(page, context);
      const sales = page.getByTestId(link("h-sales"));
      await expect(sales).toBeVisible({ timeout: 20_000 });
      const historyBefore = await page.evaluate(() => history.length);
      await sales.click();
      await settle(page);
      expect(page.url()).toMatch(/\/products\/[^/?#]+(\?[^#]*)?#h-sales$/);
      expect(await page.evaluate(() => history.length), "no new history entry").toBe(historyBefore);

      await page.reload();
      await expect(page.getByTestId(STRIP)).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("#h-sales")).toBeVisible({ timeout: 20_000 });
      await settle(page);
      const strip = await boxOf(page, `[data-testid="${STRIP}"]`);
      const heading = await boxOf(page, "#h-sales");
      const vh = page.viewportSize()!.height;
      expect(
        heading.y,
        "Sales is under the strip, not at the top of the page",
      ).toBeGreaterThanOrEqual(strip.y + strip.height - SLACK);
      expect(heading.y + heading.height, "the Sales heading is in view").toBeLessThanOrEqual(vh);
      await shot(page, info, `k11-03-reload-${vp.name}`);
    });

    test("K11-03: the query survives the hash", async ({ page, context }) => {
      const { productId } = await openProduct(page, context);
      await page.goto(`/products/${productId}?k11nav=1`);
      await expect(page.getByTestId(STRIP)).toBeVisible({ timeout: 20_000 });
      const sales = page.getByTestId(link("h-sales"));
      await expect(sales).toBeVisible({ timeout: 20_000 });
      await sales.click();
      expect(page.url()).toMatch(/\?k11nav=1#h-sales$/);
    });
  });
}
