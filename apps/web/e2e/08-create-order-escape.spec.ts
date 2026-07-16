/**
 * WP-1: Create Order — Escape scopes to the add-item sub-flow (no whole-order
 * discard) + auto-park-to-draft safety net.
 *
 * Role: OPERATOR (pre-authed via the "operator" Playwright project storage state).
 * Runs against the seeded e2e tenant, which has customers + products.
 */

import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

test.describe("Operator — Create Order Escape scoping (WP-1)", () => {
  test.beforeEach(async ({ page, context }) => {
    await setTenantCookie(context, BASE);
    await page.goto("/orders");
  });

  async function openBuilderWithCustomer(page: import("@playwright/test").Page) {
    await page
      .getByRole("button", { name: /new order/i })
      .first()
      .click();
    const title = page.getByRole("heading", { name: "Create Order" });
    await expect(title).toBeVisible({ timeout: 10_000 });
    // Pick the first customer so the product search renders. "e" matches most
    // seeded business names on the e2e tenant.
    await page.getByPlaceholder("Search by business name…").fill("e");
    await page.locator("ul li button").first().click({ timeout: 10_000 });
    return title;
  }

  test("ESC-01 Escape while adding an item clears the item search but keeps the order open", async ({
    page,
  }) => {
    const title = await openBuilderWithCustomer(page);

    const productSearch = page.getByPlaceholder("Search by name, SKU or scan barcode…");
    await productSearch.fill("test");
    await expect(productSearch).toHaveValue("test");

    // First Escape: cancels ONLY the item sub-flow. The order builder stays open.
    await productSearch.press("Escape");
    await expect(productSearch).toHaveValue("");
    await expect(title).toBeVisible();

    // Second Escape (no active sub-flow) dismisses the builder.
    await page.keyboard.press("Escape");
    await expect(title).toBeHidden({ timeout: 10_000 });
  });

  test("ESC-02 dismissing a started order auto-parks it as a draft (nothing lost)", async ({
    page,
  }) => {
    const title = await openBuilderWithCustomer(page);

    // Cancel with a customer selected → the order is parked to a draft, not lost.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(title).toBeHidden({ timeout: 10_000 });

    // The parked order surfaces in the draft dock (toast confirms the save).
    await expect(page.getByText(/saved as draft|draft parked/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
