/**
 * WP2 (14): Pack-size prompt — the product-create modal's parser refusal
 * contract made visible (`PackSizePrompt.tsx` / `@routeflow/types`'s
 * `suggestPackSize`).
 *
 * Role: OPERATOR. READ-ONLY BY CONTRACT: the modal is opened once, driven
 * through three name/unit combinations that exercise HIGH, AMBIGUOUS and
 * PIECE_UNIT confidence, and closed via its own ✕ button without ever
 * submitting — the "Create product" button is never clicked, so nothing is
 * saved to the tenant's catalog.
 *
 * Selectors scope to the dialog by role and name and use the form's linked labels
 * (`getByLabel`): the create form lives in the shared Modal. The pack-size input
 * is told apart by `PackSizePrompt`'s own `aria-label="Pieces per box"`.
 */

import { test, expect, type Page, type Locator } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

test.describe("Operator — Product-create pack-size prompt (WP2-14)", () => {
  test.beforeEach(async ({ page, context }) => {
    await setTenantCookie(context, BASE);
    await page.goto("/products");
  });

  /** Opens the create-product modal; returns its heading and a scope for the whole panel. */
  async function openCreateModal(page: Page) {
    await page.getByRole("button", { name: "New Product", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "New product" });
    const heading = modal.getByRole("heading", { name: "New product" });
    await expect(heading).toBeVisible({ timeout: 10_000 });
    return { heading, modal };
  }

  /** Closes via the header's ✕ button (same as 02-operator's quick-create close) — never saves. */
  async function closeCreateModal(page: Page, heading: Locator) {
    await page.getByRole("dialog").getByRole("button", { name: /close/i }).click();
    await expect(heading).toBeHidden({ timeout: 10_000 });
  }

  function nameField(modal: Locator) {
    return modal.getByLabel("Name *", { exact: true });
  }

  function unitField(modal: Locator) {
    return modal.getByLabel("Unit *", { exact: true });
  }

  /** The pack-size prompt's own count input — see the file header on why `getByLabel` disambiguates. */
  function packSizeInput(page: Page) {
    return page.getByLabel("Pieces per box");
  }

  /** No prompt of ANY confidence rendered — covers all three copy variants, not just the input. */
  async function expectNoPrompt(page: Page) {
    await expect(packSizeInput(page)).toHaveCount(0);
    await expect(page.getByText(/sold in a box|different counts|pieces in a box/i)).toHaveCount(0);
  }

  test("PACKSIZE-01 HIGH prefills, AMBIGUOUS refuses empty, PIECE_UNIT shows nothing — never saves", async ({
    page,
  }) => {
    const { heading, modal } = await openCreateModal(page);

    // (a) "E2E Cola 24PK" + unit "case" → HIGH confidence, prefilled 24.
    await nameField(modal).fill("E2E Cola 24PK");
    await unitField(modal).fill("case");
    await unitField(modal).press("Escape"); // close the unit combobox's own dropdown
    await expect(page.getByText(/looks like this is sold in a box of\s*24/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(packSizeInput(page)).toHaveValue("24");

    // (b) "E2E Shot 5CT - 12Pack" → two distinct counts, AMBIGUOUS, empty input,
    // copy naming both. `.fill()` fully replaces the prior name — no separate clear needed.
    await nameField(modal).fill("E2E Shot 5CT - 12Pack");
    await expect(page.getByText(/mentions 2 different counts/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/\(5 or 12\)/)).toBeVisible();
    await expect(packSizeInput(page)).toHaveValue("");
    // The refusal contract: no count to accept, so the accept button stays disabled.
    await expect(page.getByRole("button", { name: "Set pack size" })).toBeDisabled();

    // (c) "E2E Widget 12CT" + unit "each" → sold by the piece, no prompt at all.
    await nameField(modal).fill("E2E Widget 12CT");
    await unitField(modal).fill("each");
    await unitField(modal).press("Escape");
    await expectNoPrompt(page);

    // Close without saving — "Create product" is never clicked.
    await closeCreateModal(page, heading);
  });
});
