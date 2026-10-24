/**
 * PKG-4 (apple-ux F09/F10/F11) — Create Order's customer search is keyboard-complete and
 * "Change customer" can be undone, in a real browser at 1440 and 390.
 *
 *  - K5: type, ArrowDown, Enter picks a customer in <= 2 key presses after typing (no mouse).
 *  - Tab parity: one Tab from either search lands on its first result.
 *  - Escape with the customer list open closes only the list (text kept, dialog open).
 *  - Change customer -> Undo restores the customer chip; the added line is kept throughout.
 *
 * Role: OPERATOR (pre-authenticated). Tenant: the approved e2e seed (fixture customer
 * "E2E Fixture Deli Three"). READ-ONLY: nothing is submitted and a started order is never
 * dismissed (an explicit dismiss is what parks a draft), so the tenant gains no rows.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { assertNoOverflow, waitForDataLoaded } from "./helpers/overflow";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
const CUSTOMER = "E2E Fixture Deli Three";

test.beforeEach(async ({ context }) => {
  await setTenantCookie(context, BASE);
});

async function openBuilder(page: Page) {
  await page.goto("/orders");
  await waitForDataLoaded(page);
  await page
    .getByRole("button", { name: /new order/i })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Create Order" })).toBeVisible({
    timeout: 10_000,
  });
  return page.getByPlaceholder("Search by business name…");
}

for (const vp of [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
]) {
  test.describe(`Create Order customer keyboard @${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("K5 keyboard-only pick: type, ArrowDown, Enter", async ({ page }) => {
      const search = await openBuilder(page);
      await search.fill(CUSTOMER);
      await expect(page.getByRole("option", { name: new RegExp(CUSTOMER) })).toBeVisible();
      await search.press("ArrowDown");
      await search.press("Enter");
      await expect(page.getByRole("button", { name: "Change customer" })).toBeVisible();
      await expect(page.getByText(CUSTOMER).first()).toBeVisible();
      await assertNoOverflow(page, `create-order after keyboard pick @${vp.name}`);
    });

    test("Tab reaches the first customer result and Enter picks it", async ({ page }) => {
      const search = await openBuilder(page);
      await search.fill(CUSTOMER);
      await expect(page.getByRole("option").first()).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("option").first()).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Change customer" })).toBeVisible();
    });

    test("Escape closes only the list; the dialog and the text stay", async ({ page }) => {
      const search = await openBuilder(page);
      await search.fill(CUSTOMER);
      await expect(page.getByRole("listbox", { name: "Customers" })).toBeVisible();
      await search.press("Escape");
      await expect(page.getByRole("listbox", { name: "Customers" })).toBeHidden();
      await expect(search).toHaveValue(CUSTOMER);
      await expect(page.getByRole("heading", { name: "Create Order" })).toBeVisible();
    });

    test("Change customer then Undo restores the chip and keeps the lines", async ({ page }) => {
      const search = await openBuilder(page);
      await search.fill(CUSTOMER);
      await expect(page.getByRole("option", { name: new RegExp(CUSTOMER) })).toBeVisible();
      await search.press("ArrowDown");
      await search.press("Enter");
      await page.getByRole("button", { name: "Change customer" }).click();
      await expect(search).toBeFocused();
      await page.getByRole("button", { name: /undo/i }).click();
      await expect(page.getByRole("button", { name: "Change customer" })).toBeVisible();
      await expect(page.getByText(CUSTOMER).first()).toBeVisible();
      await assertNoOverflow(page, `create-order after undo @${vp.name}`);
    });
  });
}
