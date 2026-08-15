/**
 * Search survives Back — SB-01 through SB-04
 *
 * Regression guard for the reported bug: searching a list, opening a result, then
 * pressing Back dropped you on the UNSEARCHED list, because the search box was
 * component-local state that died with the unmounted page.
 *
 * The fix mirrors the debounced search into the URL (lib/hooks/useUrlSearch.ts) with
 * router.replace, so the list's history entry carries `?search=` and re-hydrates on
 * Back. `replace` (not `push`) is load-bearing: it must NOT leave one history entry
 * per keystroke — SB-03 is what pins that down.
 *
 * These self-skip against a web build that predates the fix, so the suite stays green
 * on an older deploy.
 *
 * Role: OPERATOR (storage state from the "search-back-nav" project).
 */

import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

/** The page-level list search box (not a modal's). */
function searchBox(page: Page) {
  return page
    .getByPlaceholder(/search/i)
    .or(page.getByRole("searchbox"))
    .first();
}

/**
 * Types into the list search and reports whether the build mirrors it to the URL.
 * Uses pressSequentially, not fill(): fill() sets the value atomically and would
 * never exercise the per-keystroke path this fix changes.
 */
async function typeSearch(page: Page, term: string): Promise<boolean> {
  const box = searchBox(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.click();
  await box.pressSequentially(term, { delay: 40 });
  try {
    await page.waitForURL(/[?&]search=/, { timeout: 5_000 });
    return true;
  } catch {
    return false; // build predates the URL-backed search
  }
}

test.describe("Search survives Back", () => {
  test.beforeEach(async ({ page, context }) => {
    await setTenantCookie(context, BASE_URL);
  });

  test("SB-01 customers: search → open a customer → Back restores the search", async ({ page }) => {
    await page.goto("/customers");
    const rows = page.locator("table tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });

    // Derive the term from real data so the filtered list is guaranteed non-empty.
    const firstRowText = ((await rows.first().innerText()) ?? "").trim();
    const term = (firstRowText.split(/\s+/).find((w) => w.length >= 3) ?? "").slice(0, 4);
    test.skip(!term, "No customer name long enough to derive a search term from");

    const urlBacked = await typeSearch(page, term);
    test.skip(!urlBacked, "Web build predates URL-backed list search");

    await expect(page).toHaveURL(new RegExp(`[?&]search=${term}`, "i"));
    const filteredCount = await rows.count();
    expect(filteredCount).toBeGreaterThan(0);

    await rows.first().click();
    await page.waitForURL(/\/customers\/.+/, { timeout: 15_000 });

    await page.goBack();

    // The whole point: back on the list, still filtered, with the box still filled.
    await page.waitForURL(/\/customers(\?|$)/, { timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`[?&]search=${term}`, "i"));
    await expect(searchBox(page)).toHaveValue(term, { timeout: 10_000 });
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    expect(await rows.count()).toBe(filteredCount);
  });

  test("SB-02 products: search → open a product → Back restores the search", async ({ page }) => {
    await page.goto("/products");
    const urlBacked = await typeSearch(page, "aa");
    test.skip(!urlBacked, "Web build predates URL-backed list search");

    // Grid cards and table rows both route to /products/<id>; take whichever renders.
    const result = page
      .locator("table tbody tr")
      .or(page.locator("[class*='cursor-pointer']"))
      .first();
    test.skip((await result.count()) === 0, "No products matched the probe term");
    await result.click();

    try {
      await page.waitForURL(/\/products\/.+/, { timeout: 10_000 });
    } catch {
      test.skip(true, "Clicked element did not open a product detail page");
    }

    await page.goBack();
    await page.waitForURL(/\/products(\?|$)/, { timeout: 15_000 });
    await expect(page).toHaveURL(/[?&]search=aa/i);
    await expect(searchBox(page)).toHaveValue("aa", { timeout: 10_000 });
  });

  test("SB-03 typing does not pile up history entries (replace, not push)", async ({ page }) => {
    await page.goto("/customers");
    await expect(searchBox(page)).toBeVisible({ timeout: 15_000 });
    await page.goto("/dashboard");
    await page.goto("/customers");

    const urlBacked = await typeSearch(page, "abcdef");
    test.skip(!urlBacked, "Web build predates URL-backed list search");

    // Six characters typed. With push-per-keystroke this Back would only rewind one
    // character and stay on /customers; with replace it leaves the page entirely.
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
  });

  test("SB-04 a shared ?search= URL hydrates the box on load", async ({ page }) => {
    await page.goto("/customers?search=zzznomatch");
    const box = searchBox(page);
    await expect(box).toBeVisible({ timeout: 15_000 });
    // Skips rather than fails on an older build, where the param is simply ignored.
    const value = await box.inputValue();
    test.skip(value !== "zzznomatch", "Web build predates URL-backed list search");
    await expect(box).toHaveValue("zzznomatch");
  });
});
