/**
 * Units v2 (units-v2-field-token): the shared field-border token (--field, PR #3499 V12) changes the Input, Select,
 * Textarea and PasswordInput borders for EVERY tenant, so it is checked on a form that exists with or without
 * `flag.units_prices_v2`: the login form. LOCAL LANE ONLY (project `units-v2`), flag-independent: it neither reads nor
 * requires the flag, and writes nothing.
 *
 *  - no layout shift: the form's field boxes are the same after load settles;
 *  - an invalid field keeps the danger border (computed border colour = the danger token, not --field).
 */
import { test, expect, type Page } from "@playwright/test";

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

    test("a valid field uses --field and an invalid one keeps the danger border", async ({
      page,
    }) => {
      await page.goto("/login");
      await page.waitForLoadState("networkidle");
      const field = await tokenColor(page, "border-field");
      const danger = await tokenColor(page, "border-danger");
      expect(field).not.toBe(danger);

      const username = page.getByLabel("Username or email");
      const border = (loc: ReturnType<Page["locator"]>) =>
        loc.evaluate((el) => getComputedStyle(el).borderTopColor);
      expect(await border(username)).toBe(field);

      // Submit empty: the form's validation marks the fields invalid.
      await page.getByRole("button", { name: /^sign in$/i }).click();
      await expect(username).toHaveAttribute("aria-invalid", "true");
      expect(await border(username)).toBe(danger);
      expect(await border(username)).not.toBe(field);
    });
  });
}
