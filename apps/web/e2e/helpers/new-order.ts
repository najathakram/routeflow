import { expect, type Page } from "@playwright/test";

/**
 * Opens the Create Order builder from the "New order" button, whichever shape the button has.
 *
 * With the counter off the button opens the builder itself. With the counter on (SA-940) it is a menu
 * (`data-testid="new-order-open"`) of "Counter sale" and "Regular order", and the builder is behind
 * "Regular order". The menu variant is told apart by its test id, never by waiting for a menu that a
 * counter-off business does not have, so a counter-off run pays no extra wait.
 */
export async function openRegularOrderBuilder(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: /new order/i }).first();
  const isMenu = (await trigger.getAttribute("data-testid")) === "new-order-open";
  await trigger.click();
  if (isMenu) {
    await page.getByRole("menuitem", { name: /regular order/i }).click();
  }
  await expect(page.getByRole("heading", { name: "Create Order" })).toBeVisible({
    timeout: 10_000,
  });
}
