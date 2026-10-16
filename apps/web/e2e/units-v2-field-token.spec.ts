/**
 * Units v2 (units-v2-field-token): the shared field-border token (--field, PR #3499 V12) changes the Input, Select,
 * Textarea and PasswordInput borders for EVERY tenant, so it is checked on a form that exists with or without
 * `flag.units_prices_v2`: the login form. LOCAL LANE ONLY (project `units-v2`), flag-independent: it neither reads nor
 * requires the flag, and writes nothing.
 *
 *  - no layout shift: the form's field boxes are the same after load settles;
 *  - an invalid field keeps the danger border (computed border colour = the danger token, not --field);
 *  - FLAG-ON LEG ONLY (the last describe: it calls requireUnitsV2Flag and fails, never skips, without the flag): --field is
 *    for CONTROL borders, so the units-v2 grid frame does NOT use it while the price inputs do. Read-only.
 */
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { UNITS_V2_IDS } from "./helpers/units-v2-ids";
import { productBySku, requireUnitsV2Flag } from "./helpers/units-v2-support";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const OPERATOR_STATE = path.join(__dirname, "setup/.auth/operator.json");

const SIZES = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const;

// The login form is public: no operator session.
test.use({ storageState: { cookies: [], origins: [] } });

/** The computed border colour a utility class resolves to, read from a throwaway element so the token is the source. */
async function tokenColor(page: Page, cls: string): Promise<string> {
  return page.evaluate((c) => {
    const el = document.createElement("div");
    el.className = `border ${c}`;
    el.style.cssText = "position:absolute;visibility:hidden;border-style:solid;border-width:1px";
    document.body.appendChild(el);
    const colour = getComputedStyle(el).borderTopColor;
    el.remove();
    return colour;
  }, cls);
}

const fieldBoxes = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("form input")].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: (el as HTMLInputElement).name || el.id,
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
      };
    }),
  );

for (const vp of SIZES) {
  test.describe(`Field token @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("the login form does not shift after load", async ({ page }) => {
      await page.goto("/login");
      await expect(page.getByLabel("Username or email")).toBeVisible();
      await page.waitForLoadState("networkidle");
      const first = await fieldBoxes(page);
      expect(first.length).toBeGreaterThan(1);
      await page.waitForTimeout(600);
      expect(await fieldBoxes(page)).toEqual(first);
    });

    // The login form is NOT the probe: the auth shell (.rf-auth, auth-shell.css) deliberately restyles its inputs'
    // border. The New Customer modal is a plain shared-Input form on the operator session.
    test.describe("shared Input in a form", () => {
      test.use({ storageState: OPERATOR_STATE });

      test("a valid field uses --field and an invalid one keeps the danger border", async ({
        page,
      }) => {
        await page.goto("/customers");
        await page.waitForLoadState("networkidle");
        await page.getByRole("button", { name: "New Customer" }).click();
        const dialog = page.getByRole("dialog");
        const field = await tokenColor(page, "border-field");
        const danger = await tokenColor(page, "border-danger");
        expect(field).not.toBe(danger);

        const business = dialog.locator('input[name="businessName"]');
        await expect(business).toBeVisible();
        const border = (loc: ReturnType<Page["locator"]>) =>
          loc.evaluate((el) => getComputedStyle(el).borderTopColor);
        expect(await border(business)).toBe(field);

        // Submit empty: the form's validation marks the required field invalid.
        await dialog.getByRole("button", { name: /^create customer$/i }).click();
        await expect(business).toHaveAttribute("aria-invalid", "true");
        // Submit moves focus to the invalid field and focus hides the border (ring instead): blur first, then wait out
        // the colour transition.
        await business.blur();
        await expect.poll(() => border(business)).toBe(danger);
        expect(await border(business)).not.toBe(field);
      });
    });
  });
}

for (const vp of SIZES) {
  test.describe(`Field token on the units-v2 grid @ ${vp.name} (flag-on leg)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, storageState: OPERATOR_STATE });

    test("the grid frame is not --field; the price inputs are", async ({ page, context }) => {
      await setTenantCookie(context, BASE);
      const ctx = await requireUnitsV2Flag(page);
      const product = await productBySku(page, ctx, "E2E-FIX-UNITS");
      await page.goto(`/products/${product.id}`);
      const grid = page.getByTestId(UNITS_V2_IDS.grid);
      await expect(grid).toBeVisible({ timeout: 20_000 });

      const field = await tokenColor(page, "border-field");
      const border = (loc: ReturnType<Page["locator"]>) =>
        loc.evaluate((el) => getComputedStyle(el).borderTopColor);
      expect(await border(grid)).not.toBe(field);

      await page.getByTestId("units-v2-btn-edit").click();
      const input = grid.locator('[data-testid^="units-v2-input-"]:visible').first();
      await expect(input).toBeVisible();
      // Edit mode focuses the first input and a focused input draws the brand border: blur it to read the resting border.
      await input.evaluate((el) => (el as HTMLInputElement).blur());
      await expect.poll(() => border(input)).toBe(field);
      // still the frame, not a control, in edit mode
      expect(await border(grid)).not.toBe(field);
    });
  });
}
