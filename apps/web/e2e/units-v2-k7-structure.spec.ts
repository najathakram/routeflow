/**
 * Units v2 (units-v2-k7-structure): K7's unit panels mounted in the product page's v2 shell (K10d), proven in a real
 * browser at 1440 / 768 / 390. Covers K7-PROOFS V15 (one "Add a unit"), V17 (Escape closes what you opened, focus
 * returns) and V19 (the section headings the jump strip targets), plus the layout rule that an open panel never sits on
 * the Change prices panel or the Edit save bar.
 *
 * LOCAL LANE ONLY (project `units-v2`). Panels are mostly opened and closed, never confirmed. Two cases do write, and
 * both leave the fixture unchanged: the duplicate-name case submits and the server refuses it (409, nothing created);
 * the priced-add case creates a throwaway unit, proves its price stays an unsaved draft, then removes the unit again
 * through K7's Remove (cleanup is in a `finally` and logs instead of asserting). A price is otherwise typed only to
 * prove the controls wait, then discarded. Role: OPERATOR on the approved test tenant; fixture product E2E-FIX-UNITS
 * (apps/api/scripts/e2e-seed.js), which must carry at least one removable unit row. A tenant not served
 * `flag.units_prices_v2` (or `flag.units_v1`) FAILS the spec.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const SKU = "E2E-FIX-UNITS";
const ID = {
  grid: "units-v2-grid",
  addOpen: "units-v2-add-open",
  addPanel: "units-v2-add-panel",
  addName: "units-v2-add-name",
  addCancel: "units-v2-add-cancel",
  removePanel: "units-v2-remove-panel",
  resetOpen: "units-v2-reset-open",
  resetPanel: "units-v2-reset-panel",
  change: "units-v2-btn-change-open",
  changePanel: "units-v2-change-panel",
  edit: "units-v2-btn-edit",
  bar: "units-v2-editbar",
  cancel: "units-v2-eb-cancel",
  discard: "units-v2-eb-discard",
  jump: "units-v2-jump",
};
const DIRTY_HINT = "Save or discard your price changes first";

async function openProduct(page: Page, context: Parameters<typeof setTenantCookie>[0]) {
  await setTenantCookie(context, BASE);
  const ctx = await requireUnitsV2Flag(page);
  const product = await productBySku(page, ctx, SKU);
  await page.goto(`/products/${product.id}`);
  await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });
  return { ...ctx, productId: product.id };
}

/** The table and the phone cards both render each id; only one is visible at a width. */
const vis = (page: Page, testId: string): Locator =>
  page.locator(`[data-testid="${testId}"]:visible`);
const removeButtons = (page: Page) =>
  page.locator(
    '[data-testid^="units-v2-rm-"]:not([data-testid="units-v2-rm-confirm"]):not([data-testid="units-v2-rm-cancel"]):visible',
  );
const focusedTestId = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);

const box = async (loc: Locator, what: string) => {
  const b = await loc.boundingBox();
  expect(b, `${what} has a box`).toBeTruthy();
  return b!;
};
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width - 1 &&
  b.x < a.x + a.width - 1 &&
  a.y < b.y + b.height - 1 &&
  b.y < a.y + a.height - 1;

for (const vp of VIEWPORTS) {
  test.describe(`Units v2 K7 structure (K10d) @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("V15 + V17: one Add a unit; Cancel and Escape close it and focus returns to the opener", async ({
      page,
      context,
    }, info) => {
      await openProduct(page, context);
      const opener = page.getByTestId(ID.addOpen);
      await expect(opener, "exactly one Add a unit control").toHaveCount(1);
      await expect(page.getByRole("button", { name: "Add a unit", exact: true })).toHaveCount(1);
      // the old Units card's always-open form is gone from the v2 page
      await expect(page.locator("#new-unit-name")).toHaveCount(0);

      await opener.click();
      await expect(page.getByTestId(ID.addPanel)).toBeVisible();
      await expect(opener).toBeHidden();
      await expect(page.getByTestId(ID.addName)).toBeFocused();
      await shot(page, info, "k10d-add-open");

      await page.getByTestId(ID.addCancel).click();
      await expect(page.getByTestId(ID.addPanel)).toHaveCount(0);
      await expect(opener).toBeVisible();
      await expect(opener).toBeFocused();

      await opener.click();
      await expect(page.getByTestId(ID.addPanel)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(ID.addPanel)).toHaveCount(0);
      await expect(opener).toBeVisible();
      await expect(opener).toBeFocused();
    });

    test("V15: a duplicate unit name shows the refusal in the panel and leaves it open", async ({
      page,
      context,
    }) => {
      await openProduct(page, context);
      // R3: Remove exists only while the grid is in edit mode.
      await page.getByTestId(ID.edit).click();
      const label = (await removeButtons(page).first().innerText()).replace(/^Remove\s+/, "");
      expect(label, "the fixture has a unit row to duplicate").not.toBe("");
      await page.getByTestId(ID.addOpen).click();
      await page.getByTestId(ID.addName).fill(label);
      await page.getByTestId("units-v2-add-n").fill("2");
      await page.getByTestId("units-v2-add-submit").click();
      await expect(page.getByTestId("units-v2-add-err")).not.toBeEmpty();
      await expect(page.getByTestId(ID.addPanel)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(ID.addPanel)).toHaveCount(0);
    });

    test("V17: Remove and Reset to Auto open under their control, and Escape closes them with focus back", async ({
      page,
      context,
    }, info) => {
      await openProduct(page, context);
      // R3: Remove exists only while the grid is in edit mode.
      await page.getByTestId(ID.edit).click();
      const rm = removeButtons(page).first();
      await expect(rm, "the fixture has a removable unit row").toBeVisible();
      const rmId = await rm.getAttribute("data-testid");
      await rm.click();
      await expect(page.getByTestId(ID.removePanel)).toBeVisible();
      await expect(page.getByTestId("units-v2-rm-cancel")).toBeFocused();
      await shot(page, info, "k10d-remove-open");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(ID.removePanel)).toHaveCount(0);
      expect(await focusedTestId(page)).toBe(rmId);

      const reset = page.getByTestId(ID.resetOpen);
      await expect(reset, "the fixture has a typed price Reset can clear").toBeVisible();
      await reset.click();
      await expect(page.getByTestId(ID.resetPanel)).toBeVisible();
      await expect(reset).toBeHidden();
      await shot(page, info, "k10d-reset-open");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(ID.resetPanel)).toHaveCount(0);
      await expect(reset).toBeFocused();
    });

    test("an open panel never sits on the Change prices panel or on the Edit save bar", async ({
      page,
      context,
    }, info) => {
      await openProduct(page, context);
      await page.getByTestId(ID.change).click();
      const change = page.getByTestId(ID.changePanel);
      await expect(change).toBeVisible();
      await page.getByTestId(ID.addOpen).click();
      const add = page.getByTestId(ID.addPanel);
      await expect(add).toBeVisible();
      const [c, a] = [
        await box(change, "the Change prices panel"),
        await box(add, "the add panel"),
      ];
      expect(overlaps(c, a), "the add panel is clear of the Change prices panel").toBe(false);
      expect(a.y, "the add panel sits under the Change prices panel").toBeGreaterThanOrEqual(
        c.y + c.height - 1,
      );
      await shot(page, info, "k10d-add-under-change");
      await page.keyboard.press("Escape"); // one panel per press
      await page.keyboard.press("Escape");
      await expect(add).toHaveCount(0);
      await expect(change).toHaveCount(0);

      await page.getByTestId(ID.edit).click();
      const bar = page.getByTestId(ID.bar);
      await expect(bar).toBeVisible();
      await page.getByTestId(ID.addOpen).click();
      await expect(add).toBeVisible();
      await expect(page.getByTestId(ID.addName)).toBeFocused();
      const [b, name] = [await box(bar, "the save bar"), await box(add, "the add panel")];
      expect(overlaps(b, name), "the add panel is clear of the save bar").toBe(false);
      const field = await box(page.getByTestId(ID.addName), "the unit name box");
      expect(
        field.y + field.height,
        "the focused name box is above the save bar",
      ).toBeLessThanOrEqual(b.y + 1);
      await page.keyboard.press("Escape");
      await page.getByTestId(ID.cancel).click();
      await expect(bar).toHaveCount(0);
    });

    test("V15: with an unsaved price, Add, Remove and Reset wait and say why", async ({
      page,
      context,
    }) => {
      await openProduct(page, context);
      await page.getByTestId(ID.edit).click();
      const input = page.locator('[data-testid^="units-v2-input-"]:visible').first();
      const before = await input.inputValue();
      await input.fill(before === "9.99" ? "8.88" : "9.99");
      await expect(page.getByTestId(ID.addOpen)).toBeDisabled();
      await expect(page.getByTestId(ID.resetOpen)).toBeDisabled();
      await expect(removeButtons(page).first()).toBeDisabled();
      await expect(page.getByText(DIRTY_HINT).first()).toBeVisible();
      await page.getByTestId(ID.cancel).click();
      await page.getByTestId(ID.discard).click();
      await expect(page.getByTestId(ID.bar)).toHaveCount(0);
      await expect(page.getByTestId(ID.addOpen)).toBeEnabled();
    });

    test("a price typed in Add a unit lands as an unsaved draft on the new row, never saved", async ({
      page,
      context,
    }, info) => {
      const { api, headers, productId } = await openProduct(page, context);
      const name = `K10d tmp ${Date.now()}`;
      let submitted = false;
      try {
        await page.getByTestId(ID.addOpen).click();
        await page.getByTestId(ID.addName).fill(name);
        await page.getByTestId("units-v2-add-n").fill("7");
        await page.getByTestId("units-v2-add-price").fill("1.23");
        submitted = true;
        await page.getByTestId("units-v2-add-submit").click();
        await expect(page.getByTestId(ID.addPanel)).toHaveCount(0);

        const row = page
          .locator('[data-testid^="units-v2-row-"], [data-testid^="units-v2-card-"]')
          .filter({ hasText: name })
          .locator("visible=true")
          .first();
        const input = row.locator('[data-testid^="units-v2-input-"][data-testid$="-1"]:visible');
        await expect(input).toHaveValue("1.23");
        await expect(page.getByTestId(ID.bar)).toBeVisible();
        await expect(page.getByTestId("units-v2-eb-text")).toContainText("1 unsaved");
        await shot(page, info, "k10d-add-with-price");

        await page.getByTestId(ID.cancel).click();
        await page.getByTestId(ID.discard).click();
        await expect(page.getByTestId(ID.bar)).toHaveCount(0);

        // never saved: the served grid still has the new unit's Retail on Auto
        const res = await page.request.get(`${api}/products/${productId}/price-grid`, { headers });
        const grid: any = await res.json();
        const made = grid.rows.find((r: any) => r.label === name);
        expect(made, "the throwaway unit exists").toBeTruthy();
        expect(made.cells.find((c: any) => c.tier === 1).source).toBe("auto");
      } finally {
        if (submitted) {
          try {
            await page.goto(`/products/${productId}`);
            await page.getByTestId(ID.edit).click();
            const rm = page.getByRole("button", { name: `Remove ${name}`, exact: true });
            await rm.locator("visible=true").first().click();
            await page.getByTestId("units-v2-rm-confirm").click();
            await expect(page.getByRole("button", { name: `Remove ${name}` })).toHaveCount(0);
          } catch (e) {
            console.log(
              `K10d cleanup: could not remove the throwaway unit "${name}" through the UI: ${e}`,
            );
            try {
              const list = await page.request.get(`${api}/products/${productId}/units`, {
                headers,
              });
              const units: any[] = await list.json();
              const mine = units.find((u) => u.label === name);
              if (mine)
                await page.request.delete(`${api}/products/${productId}/units/${mine.id}`, {
                  headers,
                });
            } catch (e2) {
              console.log(
                `K10d cleanup: API removal of "${name}" also failed: ${e2}. Remove it by hand.`,
              );
            }
          }
        }
      }
    });

    test("V19: the Sales and Customer view headings carry the ids the jump strip targets", async ({
      page,
      context,
    }) => {
      await openProduct(page, context);
      await expect(page.locator("#h-sales")).toHaveCount(1);
      await expect(page.locator("#h-cust")).toHaveCount(1);
      const strip = page.getByRole("navigation", { name: "On this page" });
      await expect(strip.getByRole("link")).not.toHaveCount(0);
      const sales = strip.locator('a[href="#h-sales"]');
      await expect(sales).toHaveCount(1);
      await sales.click();
      await expect(page.locator("#h-sales")).toBeFocused();
    });
  });
}
