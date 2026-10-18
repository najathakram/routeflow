/**
 * K11-16 (lane L2): "Saved N prices. Undo" shows where the Edit bar was, for 5 s, then settles back into the section.
 *
 * NOT RUN: written without a browser (Jest + RTL proves the classes, timers, order, reserved height and one-live-region rule in
 * `units-v2/confirm/SaveStatusLine.k11-16.test.tsx`). This spec carries the pixel claims and must be run on the local
 * compose stack (`npm run local:up` + `local:seed`, then `npm run local:e2e`), flag `flag.units_prices_v2` ON.
 *
 * It SAVES a price on the approved test tenant's fixture product E2E-FIX-UNITS and undoes it again, so it leaves the
 * product as it found it. A tenant not served the flag FAILS the spec (never a skip).
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { VIEWPORTS, productBySku, requireUnitsV2Flag } from "./helpers/units-v2-support";

/** The base URL comes from the environment only. Unset is an error, never a default site. */
function baseUrl(): string {
  const url = process.env.PLAYWRIGHT_BASE_URL;
  if (!url) throw new Error("PLAYWRIGHT_BASE_URL is not set: point this spec at the local stack.");
  return url;
}

const SKU = "E2E-FIX-UNITS";
const ID = {
  edit: "units-v2-btn-edit",
  save: "units-v2-eb-save",
  bar: "units-v2-editbar",
  line: "units-v2-save-status",
  undo: "units-v2-save-undo",
};

async function openProduct(page: Page, context: Parameters<typeof setTenantCookie>[0]) {
  await setTenantCookie(context, baseUrl());
  const ctx = await requireUnitsV2Flag(page);
  const product = await productBySku(page, ctx, SKU);
  await page.goto(`/products/${product.id}`);
  await expect(page.getByTestId("units-v2-grid")).toBeVisible({ timeout: 20_000 });
}

/** Edit, then raise the first visible Retail box by one cent so there is something to save. */
async function stageOneChange(page: Page) {
  await page.getByTestId(ID.edit).click();
  const input = page.locator('[data-testid^="units-v2-input-"][data-testid$="-1"]:visible').first();
  await expect(input).toBeVisible();
  const was = Number((await input.inputValue()).replace(/[$,]/g, ""));
  await input.fill((was + 0.01).toFixed(2));
}

/** True when the box lies fully inside the viewport. */
async function inViewport(page: Page, testId: string) {
  const b = await page.getByTestId(testId).boundingBox();
  const vp = page.viewportSize()!;
  return !!b && b.y >= 0 && b.y + b.height <= vp.height && b.x >= 0 && b.x + b.width <= vp.width;
}

/**
 * The distance from the pricing region's top (`units-v2-region`, the section's stable ancestor: the page has no <section>)
 * to the first element after it (document order, outside it). Region-relative, so it does not depend on scroll. K11-16 (MM's proof): the settled line used to add its own height
 * here (+45.5 px at every width) because the fixed line took no space while pinned.
 */
async function belowOffset(page: Page): Promise<number> {
  return page.getByTestId(ID.line).evaluate((line) => {
    const section = line.closest('[data-testid="units-v2-region"]');
    if (!section)
      throw new Error("the saved line is not inside the pricing region (units-v2-region)");
    let n: Element | null = section;
    while (n && !n.nextElementSibling) n = n.parentElement;
    const below = n?.nextElementSibling;
    if (!below) throw new Error("nothing follows the pricing section to measure against");
    return below.getBoundingClientRect().top - section.getBoundingClientRect().top;
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`K11-16 saved line @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const how of ["Save button", "Ctrl+S"] as const) {
      test(`${how}: the saved line is on screen within 1 s with no scroll, Undo works, it settles after 5 s`, async ({
        page,
        context,
      }) => {
        await openProduct(page, context);
        await stageOneChange(page);
        const line = page.getByTestId(ID.line);

        if (how === "Save button") await page.getByTestId(ID.save).click();
        else await page.keyboard.press("Control+s");

        // Within 1 s, without scrolling, and pinned: the line is the one live region saying Saved.
        await expect(line).toContainText("Saved", { timeout: 1000 });
        expect(await inViewport(page, ID.line), "the saved line is in the viewport").toBe(true);
        await expect(line).toHaveAttribute("data-pinned", "true");
        await expect(page.getByRole("status").filter({ hasText: "Saved" })).toHaveCount(1);

        // It rests at the real bottom, where the bar was (not lifted by the shell's 96px padding).
        const box = (await line.boundingBox())!;
        expect(
          Math.abs(page.viewportSize()!.height - (box.y + box.height)),
          "pinned at the real bottom",
        ).toBeLessThanOrEqual(2);

        // The space under the line is reserved while it is pinned: what follows the section does not move when it settles.
        const belowPinned = await belowOffset(page);

        // After 5 s it lets go: same element, still saying Saved with Undo, back in its place in the section.
        await expect(line).toHaveAttribute("data-pinned", "false", { timeout: 7000 });
        await page.waitForTimeout(300); // the fade is 150 ms; measure once it is fully settled
        expect(
          Math.abs((await belowOffset(page)) - belowPinned),
          "the element below the section does not jump when the saved line settles (K11-16)",
        ).toBeLessThanOrEqual(1);
        await expect(line).toContainText("Saved");
        await expect(page.getByTestId(ID.undo)).toBeVisible();
        await expect(page.getByRole("status").filter({ hasText: "Saved" })).toHaveCount(1);

        // Undo restores the price (the product is left as it was found).
        await page.getByTestId(ID.undo).click();
        await expect(line).toContainText(/Save undone|Prices changed since you saved/);
      });
    }

    test("Undo from the pinned line works and un-pins first", async ({ page, context }) => {
      await openProduct(page, context);
      await stageOneChange(page);
      await page.getByTestId(ID.save).click();
      const line = page.getByTestId(ID.line);
      await expect(line).toHaveAttribute("data-pinned", "true");
      await page.getByTestId(ID.undo).click();
      await expect(line).toHaveAttribute("data-pinned", "false");
      await expect(line).toContainText(/Save undone|Prices changed since you saved/);
    });

    test("pointer over the line holds the pin past 5 s", async ({ page, context }) => {
      await openProduct(page, context);
      await stageOneChange(page);
      await page.getByTestId(ID.save).click();
      const line = page.getByTestId(ID.line);
      await line.hover();
      await page.waitForTimeout(6500);
      await expect(line).toHaveAttribute("data-pinned", "true");
      await page.mouse.move(0, 0);
      await expect(line).toHaveAttribute("data-pinned", "false", { timeout: 7000 });
      await page.getByTestId(ID.undo).click();
    });
  });
}
