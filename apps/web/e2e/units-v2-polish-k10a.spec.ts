/**
 * Units v2 (units-v2-polish-k10a): the product page's pricing polish, proven in a real browser at 1440 / 768 / 390.
 *   F02  Change prices: Apply/Cancel sit below the preview (never on it) and the Also update text is fully readable
 *   P13  Raise / Lower: only the chosen half is filled, the choice is announced (aria-checked)
 *   F22  Edit: the save bar rests at the real bottom and never covers a price box that takes focus
 *   F03  After Apply the price box shows the applied value, not the old one
 *   NIT-3  the "customers capped" note shows only when the server said truncated
 *
 * LOCAL LANE ONLY (project `units-v2`). READ-ONLY: nothing is saved (Apply only folds into the draft, which is discarded).
 * Role: OPERATOR on the approved test tenant; fixture product E2E-FIX-UNITS (apps/api/scripts/e2e-seed.js). A tenant not
 * served `flag.units_prices_v2` FAILS the spec.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const SKU = "E2E-FIX-UNITS";
const ID = {
  change: "units-v2-btn-change-open",
  panel: "units-v2-change-panel",
  preview: "units-v2-ch-preview",
  footer: "units-v2-change-footer",
  alsoUpdate: "units-v2-cp-also-update",
  truncated: "units-v2-cp-customers-truncated",
  edit: "units-v2-btn-edit",
  bar: "units-v2-editbar",
  barText: "units-v2-eb-text",
  cancel: "units-v2-eb-cancel",
  discard: "units-v2-eb-discard",
};

async function openProduct(page: Page, context: Parameters<typeof setTenantCookie>[0]) {
  await setTenantCookie(context, BASE);
  const ctx = await requireUnitsV2Flag(page);
  const product = await productBySku(page, ctx, SKU);
  await page.goto(`/products/${product.id}`);
  await expect(page.getByTestId("units-v2-grid")).toBeVisible({ timeout: 20_000 });
  return { ...ctx, productId: product.id };
}

/** The unit with a typed (Set) Retail price: the one Change prices can raise and the Retail box can show. */
async function setRetailUnit(
  page: Page,
  ctx: { api: string; headers: Record<string, string> },
  id: string,
) {
  const res = await page.request.get(`${ctx.api}/products/${id}/price-grid`, {
    headers: ctx.headers,
  });
  expect(res.ok(), `GET price-grid returned ${res.status()}`).toBe(true);
  const grid: any = await res.json();
  const row = grid.rows.find(
    (r: any) =>
      r.editable &&
      r.cells.some((c: any) => c.tier === 1 && c.source === "set" && Number(c.value) > 0),
  );
  expect(
    row,
    `${SKU} has no unit with a typed Retail price: re-run apps/api/scripts/e2e-seed.js`,
  ).toBeTruthy();
  const cell = row.cells.find((c: any) => c.tier === 1);
  return { ref: row.ref as string, label: row.label as string, retail: Number(cell.value) };
}

const box = async (page: Page, testId: string) => {
  const b = await page.getByTestId(testId).boundingBox();
  expect(b, `${testId} has a box`).toBeTruthy();
  return b!;
};

const bg = (page: Page, label: string) =>
  page
    .locator("label", { hasText: new RegExp(`^${label}$`) })
    .evaluate((el) => getComputedStyle(el).backgroundColor);

for (const vp of VIEWPORTS) {
  test.describe(`Units v2 polish K10a @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("F02 + P13: Change prices reads clean, Apply sits below the preview, one half of Raise/Lower is filled", async ({
      page,
      context,
    }, info) => {
      const { api, headers, productId } = await openProduct(page, context);
      const unit = await setRetailUnit(page, { api, headers }, productId);
      await page.getByTestId(ID.change).click();
      const panel = page.getByTestId(ID.panel);
      await expect(panel).toBeVisible();

      // P13: Raise is chosen first: filled, announced; Lower is outlined (a different, lighter fill)
      const raise = panel.getByRole("radio", { name: "Raise" });
      const lower = panel.getByRole("radio", { name: "Lower" });
      await expect(raise).toBeChecked();
      await expect(raise).toHaveAttribute("aria-checked", "true");
      await expect(lower).toHaveAttribute("aria-checked", "false");
      const [raiseOn, lowerOff] = [await bg(page, "Raise"), await bg(page, "Lower")];
      expect(raiseOn, "the chosen half is filled").not.toBe(lowerOff);
      await page.getByText("Lower", { exact: true }).click();
      await expect(lower).toHaveAttribute("aria-checked", "true");
      await expect(raise).toHaveAttribute("aria-checked", "false");
      expect(await bg(page, "Lower"), "the fill moved to Lower").toBe(raiseOn);
      expect(await bg(page, "Raise")).toBe(lowerOff);
      await page.getByText("Raise", { exact: true }).click();

      // F02: with an amount typed the preview shows, and Apply/Cancel sit BELOW it, on nothing
      await panel.getByLabel("Unit").selectOption(unit.ref);
      await panel.getByLabel("Amount").fill("5");
      const preview = page.getByTestId(ID.preview);
      await expect(preview.getByRole("row").first()).toBeVisible();
      await preview.scrollIntoViewIfNeeded();
      const rows = preview.getByRole("row");
      const footer = await box(page, ID.footer);
      const n = await rows.count();
      expect(n, "the preview lists the changed prices").toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        const r = await rows.nth(i).boundingBox();
        expect(r!.y + r!.height, `preview row ${i} ends above Apply/Cancel`).toBeLessThanOrEqual(
          footer.y + 1,
        );
      }
      // the Also update text reads in full: its box is as tall as its content
      const also = page.getByTestId(ID.alsoUpdate);
      await expect(also).toBeVisible();
      const clipped = await also.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
      expect(clipped, "the Also update box is not clipped").toBe(false);
      const alsoBox = await box(page, ID.alsoUpdate);
      expect(alsoBox.y + alsoBox.height, "Also update ends above Apply/Cancel").toBeLessThanOrEqual(
        footer.y + 1,
      );
      await shot(page, info, "k10a-change-prices");
    });

    test("F03: Apply writes the new price into the Retail box, not the old one", async ({
      page,
      context,
    }) => {
      const { api, headers, productId } = await openProduct(page, context);
      const unit = await setRetailUnit(page, { api, headers }, productId);
      await page.getByTestId(ID.change).click();
      const panel = page.getByTestId(ID.panel);
      await panel.getByLabel("Unit").selectOption(unit.ref);
      await panel.getByLabel("Amount").fill("10");
      await panel.getByRole("button", { name: "Apply" }).click();
      await expect(panel).toHaveCount(0);
      await expect(page.getByTestId(ID.barText)).not.toContainText("Nothing changed yet");
      const input = page.locator(`[data-testid="units-v2-input-${unit.ref}-1"]:visible`).first();
      await expect(input).toBeVisible();
      const shown = Number((await input.inputValue()).replace(/[$,]/g, ""));
      expect(shown, "the box shows the applied (raised) price").toBeGreaterThan(unit.retail);
      // nothing is saved: discard the draft
      await page.getByTestId(ID.cancel).click();
      await page.getByTestId(ID.discard).click();
      await expect(page.getByTestId(ID.bar)).toHaveCount(0);
    });

    test("F22: the save bar rests at the bottom and never covers a price box that takes focus", async ({
      page,
      context,
    }, info) => {
      await openProduct(page, context);
      await page.getByTestId(ID.edit).click();
      const bar = page.getByTestId(ID.bar);
      await expect(bar).toBeVisible();
      const viewportBottom = page.viewportSize()!.height;
      const first = await box(page, ID.bar);
      expect(
        viewportBottom - (first.y + first.height),
        "the bar sits at the real bottom, not lifted by the shell's padding",
      ).toBeLessThanOrEqual(2);

      const inputs = page.locator('[data-testid^="units-v2-input-"]:visible');
      const n = await inputs.count();
      expect(n, "edit mode shows price boxes").toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        await inputs.nth(i).focus();
        const b = await bar.boundingBox();
        const r = await inputs.nth(i).boundingBox();
        expect(
          r!.y + r!.height,
          `price box ${i} is not under the save bar once focused`,
        ).toBeLessThanOrEqual(b!.y + 1);
      }
      await shot(page, info, "k10a-edit-bar");
      await page.getByTestId(ID.cancel).click();
    });

    test("NIT-3: no 'customers capped' note when the server did not truncate; one when it did", async ({
      page,
      context,
    }) => {
      const { api, headers, productId } = await openProduct(page, context);
      const unit = await setRetailUnit(page, { api, headers }, productId);
      const amount = async () => {
        await page.getByTestId(ID.change).click();
        const panel = page.getByTestId(ID.panel);
        await panel.getByLabel("Unit").selectOption(unit.ref);
        await panel.getByLabel("Amount").fill("5");
        await expect(page.getByTestId(ID.alsoUpdate)).toBeVisible();
      };

      await amount();
      await expect(page.getByTestId(ID.truncated)).toHaveCount(0);
      await page.getByRole("button", { name: "Cancel" }).first().click();

      // the same page, with the endpoint saying it capped the list
      await page.route(`**/products/${productId}/customer-prices`, async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        await route.fulfill({ response: res, json: { ...body, truncated: true } });
      });
      await page.reload();
      await expect(page.getByTestId("units-v2-grid")).toBeVisible({ timeout: 20_000 });
      await page.getByTestId(ID.edit).click();
      await amount();
      await expect(page.getByTestId(ID.truncated)).toContainText("Showing the first 500 customers");
      await page.unroute(`**/products/${productId}/customer-prices`);
    });
  });
}
