/**
 * Units v2 (units-v2-sa984-nopack-add-unit): SA-984 D2, proven in a real browser at 1440 / 768 / 390.
 *  - A product with NO pack size (E2E-FIX-UNITS): the Add a unit panel does not offer "1 of the base unit".
 *    The count starts blank, Contains needs 2 or more, a hint says to set a pack size, and Add is disabled on 1.
 *  - A product WITH a pack size (E2E-FIX-CASEDEFAULT, Box of 24): no hint, the base unit is offered as before.
 *  - Edit mode: the pieces-per-pack field is a labelled input (clicking the label focuses it).
 *
 * LOCAL LANE ONLY (project `units-v2`). Role: OPERATOR on the approved test tenant. Read-only: nothing is created.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const NOPACK_SKU = "E2E-FIX-UNITS";
const PACK_SKU = "E2E-FIX-CASEDEFAULT";
const ID = {
  grid: "units-v2-grid",
  open: "units-v2-add-open",
  panel: "units-v2-add-panel",
  n: "units-v2-add-n",
  of: "units-v2-add-of",
  hint: "units-v2-add-nopack",
  submit: "units-v2-add-submit",
};

async function openProduct(
  page: Page,
  context: Parameters<typeof setTenantCookie>[0],
  sku: string,
) {
  await setTenantCookie(context, BASE);
  const ctx = await requireUnitsV2Flag(page);
  const product = await productBySku(page, ctx, sku);
  await page.goto(`/products/${product.id}`);
  await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });
}

const visible = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]:visible`);

for (const vp of VIEWPORTS) {
  test.describe(`Units v2 SA-984 (no-pack Add unit) @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("no pack size: blank count, Contains >= 2, hint shown, Add disabled on 1", async ({
      page,
      context,
    }, info) => {
      await openProduct(page, context, NOPACK_SKU);
      await visible(page, ID.open).first().click();
      await expect(page.getByTestId(ID.panel)).toBeVisible();
      const n = page.getByTestId(ID.n);
      await expect(n).toHaveValue("");
      await expect(n).toHaveAttribute("min", "2");
      await expect(page.getByTestId(ID.hint)).toHaveText("Set a pack size to sell single pieces.");
      await shot(page, info, "sa984-nopack-blank");

      await n.fill("1");
      await expect(page.getByTestId(ID.submit)).toBeDisabled();
      await shot(page, info, "sa984-nopack-one-disabled");

      await n.fill("6");
      await expect(page.getByTestId(ID.hint)).toBeVisible();
      await shot(page, info, "sa984-nopack-six");
    });

    test("with a pack size: no hint, the pack's own unit is offered", async ({
      page,
      context,
    }, info) => {
      await openProduct(page, context, PACK_SKU);
      await visible(page, ID.open).first().click();
      await expect(page.getByTestId(ID.panel)).toBeVisible();
      await expect(page.getByTestId(ID.hint)).toHaveCount(0);
      await expect(page.getByTestId(ID.n)).not.toHaveAttribute("min", "2");
      await shot(page, info, "sa984-pack-panel");
    });

    test("edit mode: the pieces-per-pack field is tied to its label", async ({
      page,
      context,
    }, info) => {
      await openProduct(page, context, NOPACK_SKU);
      await page
        .getByRole("button", { name: /^edit$/i })
        .first()
        .click();
      const field = page.locator("#product-units-per-box");
      await expect(field).toBeVisible();
      await page.locator('label[for="product-units-per-box"]').click();
      await expect(field).toBeFocused();
      await shot(page, info, "sa984-label-focus");
    });
  });
}
