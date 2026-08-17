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

    // Derive the term from the name cell of a real row, so the filtered list is
    // guaranteed to contain that row. Whole-row innerText would sweep in the email,
    // phone and status columns and can yield a token the name search never matches.
    const nameCell = ((await rows.first().locator("td").first().innerText()) ?? "").trim();
    const term = nameCell.split(/\s+/).find((w) => /^[a-z0-9]{3,}$/i.test(w)) ?? "";
    test.skip(!term, "No customer name usable as a search term");

    const urlBacked = await typeSearch(page, term);
    test.skip(!urlBacked, "Web build predates URL-backed list search");

    await expect(page).toHaveURL(new RegExp(`[?&]search=${term}`, "i"));
    // The URL updates when the debounce settles, but the refetch lands after it —
    // counting rows here without waiting reads the table mid-refresh (it briefly has
    // none) and the count is a phantom zero.
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const filteredCount = await rows.count();

    await rows.first().click();
    await page.waitForURL(/\/customers\/.+/, { timeout: 15_000 });

    await page.goBack();

    // The whole point: back on the list, still filtered, with the box still filled.
    await page.waitForURL(/\/customers(\?|$)/, { timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`[?&]search=${term}`, "i"));
    await expect(searchBox(page)).toHaveValue(term, { timeout: 10_000 });
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBe(filteredCount);
  });

  test("SB-02 products: search → navigate away → Back restores the search", async ({ page }) => {
    await page.goto("/products");
    // Grid cards and table rows both route to /products/<id>; take whichever renders.
    const cards = page.locator("table tbody tr").or(page.locator("[class*='cursor-pointer']"));
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });

    // Derive the term from a product actually on screen, so the search is
    // guaranteed to match something (a fixed probe string matches nothing in a
    // tenant whose catalogue does not happen to contain it).
    const cardText = ((await cards.first().innerText()) ?? "").trim();
    const term = cardText.split(/\s+/).find((w) => /^[a-z0-9]{4,}$/i.test(w)) ?? "";
    test.skip(!term, "No product name usable as a search term");

    const urlBacked = await typeSearch(page, term);
    test.skip(!urlBacked, "Web build predates URL-backed list search");
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });

    // Leave for another page rather than clicking a card: the product grid's click
    // target moves with the view mode, and the seeded tenant's parked-drafts dock
    // floats over it. Navigating away exercises the same history entry a drill-in
    // creates, so the Back assertion below is identical — and it always runs
    // instead of self-skipping on a selector that drifted.
    await page.goto("/dashboard");
    await page.goBack();
    await page.waitForURL(/\/products(\?|$)/, { timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`[?&]search=${term}`, "i"));
    await expect(searchBox(page)).toHaveValue(term, { timeout: 10_000 });
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

  // ── Page position survives Back — PB-01/PB-02 ────────────────────────────────
  // The page-number half of the same bug: paging to page 2+, opening a row, then
  // Back dropped you on page 1 because `page` was component-local state. The fix
  // mirrors it into `?page=` (lib/hooks/useUrlPage.ts). Self-skip on older builds.

  test("PB-01 products: go to page 2 → navigate away → Back restores page 2", async ({ page }) => {
    await page.goto("/products");
    const cards = page.locator("table tbody tr").or(page.locator("[class*='cursor-pointer']"));
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });

    // The "2" pager button only renders when the catalogue spans >1 page. Shrink
    // the page size first to make that likely on a small seeded tenant.
    const perPage = page
      .getByRole("combobox")
      .filter({ hasText: /per page/i })
      .first();
    if (await perPage.count()) await perPage.selectOption("20").catch(() => {});

    const page2 = page.getByRole("button", { name: "2", exact: true }).first();
    test.skip(!(await page2.count()), "Tenant catalogue does not span two pages");
    await page2.click();

    // The fix puts ?page=2 on the URL; an older build keeps it in local state.
    let urlBacked = true;
    try {
      await page.waitForURL(/[?&]page=2/, { timeout: 5_000 });
    } catch {
      urlBacked = false;
    }
    test.skip(!urlBacked, "Web build predates URL-backed page position");

    await page.goto("/dashboard");
    await page.goBack();
    await page.waitForURL(/\/products(\?|$)/, { timeout: 15_000 });
    await expect(page).toHaveURL(/[?&]page=2/);
  });

  test("PB-02 a shared ?page=2 URL is not reset to page 1 on load", async ({ page }) => {
    // Pins the mount-time guard: the "reset to page 1 when filters change" effect
    // must skip its first run, or it would strip ?page= the moment the list mounts.
    await page.goto("/products?page=2");
    const cards = page.locator("table tbody tr").or(page.locator("[class*='cursor-pointer']"));
    await expect(cards.first().or(page.getByText(/no products/i))).toBeVisible({ timeout: 15_000 });

    // Give any mount effect a beat to (wrongly) fire before asserting the param held.
    await page.waitForTimeout(1_000);
    const url = new URL(page.url());
    test.skip(url.searchParams.get("page") === null, "Web build predates URL-backed page position");
    await expect(page).toHaveURL(/[?&]page=2/);
  });
});
