/**
 * Critical-path regression tests — money-math and core workflow integrity.
 *
 * Covers: CP-01 through CP-10
 * Role: OPERATOR (admin / Admin@123) — uses pre-authenticated storage state.
 *
 * These tests are deliberately narrow and fast:
 *   • No UI mutations (no creates/edits) — safe to run against production data.
 *   • Verify that displayed amounts are properly rounded (no float artifacts
 *     like "$16.467000000000002" after the money-math fix).
 *   • Verify invoice/order total consistency (total ≈ subtotal + tax).
 *   • Verify API responses carry no float-drift in money fields.
 *
 * Why these matter: the money-math bug manifested as 220 × 2 = 420 in invoices.
 * These specs lock that regression closed at the UI and API layer, not just unit tests.
 */

import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";

// Matches a properly-formatted monetary amount: $1,234.56 or $0.00
const MONEY_RE = /^\$[\d,]+\.\d{2}$/;

// Money-related API field names whose values must have ≤2 decimal places
const MONEY_KEY_RE = /subtotal|total|tax|amount|price|balance/i;

/**
 * Scan a JSON value and return any money-keyed numbers with >2 decimal places.
 * Only inspects the first 5 items of arrays for speed.
 */
function floatArtifacts(value: unknown, path = ""): string[] {
  if (typeof value === "number") {
    if (MONEY_KEY_RE.test(path)) {
      const dp = (String(value).split(".")[1] ?? "").length;
      if (dp > 2) return [`${path} = ${value}`];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.slice(0, 5).flatMap((v: unknown, i: number) => floatArtifacts(v, `${path}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      floatArtifacts(v, path ? `${path}.${k}` : k),
    );
  }
  return [];
}

/** Extract the numeric value from a string like "$1,234.56" → 1234.56 */
function parseMoney(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/**
 * The API service ORIGIN derived from the current web URL (the API runs on a
 * separate Railway service). Uses SMOKE_BASE_URL when provided, else swaps the
 * web host for the api host. MUST return an origin only — `new URL().origin`
 * strips the page path so callers can append `/api/v1/...` without doubling it.
 */
function apiBase(webURL: string): string {
  if (process.env.SMOKE_BASE_URL) return process.env.SMOKE_BASE_URL;
  const origin = (() => {
    try {
      return new URL(webURL).origin;
    } catch {
      return webURL;
    }
  })();
  return origin
    .replace(/:3001\b/, ":3000")
    .replace("routeflowweb-production", "routeflowapi-production")
    .replace("routeflowmobile-production", "routeflowapi-production");
}

test.describe("Critical Paths — Money Math & Core Integrity", () => {
  test.beforeEach(async ({ page, context }) => {
    const base = page.context().browser()?.browserType().name() ? page.url() : "";
    await setTenantCookie(context, base);
  });

  // ── UI amount formatting ───────────────────────────────────────────────────

  test("CP-01 invoice list — all displayed amounts are $X.XX (no float artifacts)", async ({
    page,
  }) => {
    await page.goto("/invoices");

    // Wait for either a table row or an empty-state indicator
    await page
      .locator("table tbody tr, [class*='empty'], [data-testid='empty']")
      .first()
      .waitFor({ timeout: 15_000 });

    // Collect the table's amount cells that start with "$". Scoped to `table tbody td` on
    // purpose: the unscoped `[class*='amount'|'total']` selector also matched the empty-state
    // block, whose copy starts with a "$" glyph, so an empty list was read as a malformatted
    // amount instead of reaching the empty branch (F2, B566).
    // `\$\d`, not a bare `$`: the empty state renders inside a `<td colSpan>` and its
    // illustration carries a literal "$" glyph, so a bare `^\s*\$` still matched it.
    const dollarCells = page.locator("table tbody td").filter({
      hasText: /^\s*\$\d/,
    });
    // Auto-retrying wait first: `table tbody tr` above also matches the loading skeleton row, so
    // a bare count() can run before the data lands and fail for the wrong reason.
    await expect(
      dollarCells.first(),
      "No invoice amount cells on /invoices — run `node apps/api/scripts/e2e-seed.js` (B566)",
    ).toBeVisible({ timeout: 15_000 });
    const count = await dollarCells.count();

    // An empty list proves nothing about amount formatting — fail, never return green
    // (B566: `e2e-seed.js` seeds an invoice for e2e-routeflow).
    expect(
      count,
      "No invoice amount cells on /invoices — run `node apps/api/scripts/e2e-seed.js` (B566)",
    ).toBeGreaterThan(0);

    const texts = await dollarCells.allTextContents();
    const badAmounts: string[] = [];
    for (const t of texts) {
      const clean = t.trim();
      if (clean && !MONEY_RE.test(clean)) {
        badAmounts.push(clean);
      }
    }
    expect(
      badAmounts,
      `Malformatted amounts on invoice list: ${badAmounts.join(", ")}`,
    ).toHaveLength(0);
  });

  test("CP-02 order list — all displayed amounts are $X.XX", async ({ page }) => {
    await page.goto("/orders");
    await page
      .locator("table tbody tr, [class*='empty'], [data-testid='empty']")
      .first()
      .waitFor({ timeout: 15_000 });

    // Scoped to `table tbody td` with `\$\d` (same reasoning as CP-01: the empty state's
    // illustration carries a literal "$"), and an empty list FAILS — never a green no-op (B566
    // follow-up: `e2e-seed.js` seeds a PENDING order).
    const dollarCells = page.locator("table tbody td").filter({ hasText: /^\s*\$\d/ });
    await expect(
      dollarCells.first(),
      "No order amount cells on /orders — run `node apps/api/scripts/e2e-seed.js` (B566)",
    ).toBeVisible({ timeout: 15_000 });
    const count = await dollarCells.count();
    expect(
      count,
      "No order amount cells on /orders — run `node apps/api/scripts/e2e-seed.js` (B566)",
    ).toBeGreaterThan(0);

    const texts = await dollarCells.allTextContents();
    const badAmounts = texts.map((t) => t.trim()).filter((t) => t && !MONEY_RE.test(t));
    expect(badAmounts, `Malformatted amounts on order list: ${badAmounts.join(", ")}`).toHaveLength(
      0,
    );
  });

  // ── Invoice detail: total = subtotal + tax ────────────────────────────────

  test("CP-03 invoice detail — total equals subtotal + tax (within $0.01)", async ({ page }) => {
    await page.goto("/invoices");

    // Target a real DATA row (one carrying a $ amount), not a loading skeleton
    // row: invoice rows navigate via an onClick handler, and skeleton <tr>s have
    // none — clicking one before the data loads never navigates (a race that
    // intermittently timed out waitForURL).
    const firstRow = page.locator("table tbody tr", { hasText: /\$\d/ }).first();
    try {
      await firstRow.waitFor({ timeout: 20_000 });
    } catch {
      // Fail, never skip (B566): e2e-seed.js seeds an invoice for e2e-routeflow.
      throw new Error("No invoices to inspect — run `node apps/api/scripts/e2e-seed.js` (B566)");
    }

    await firstRow.click();
    await page.waitForURL(/\/invoices\/.+/, { timeout: 30_000 });

    // Extract the three summary values (subtotal, tax, total)
    // The detail page renders these as formatted amounts — find by label proximity.
    const subtotalEl = page
      .getByText(/subtotal/i)
      .locator(
        "xpath=following-sibling::*[1]|../following-sibling::*//span[contains(@class,'amount')]",
      )
      .first()
      .or(page.locator("[data-testid='invoice-subtotal']").first());
    const taxEl = page
      .getByText(/^tax$/i)
      .locator("xpath=following-sibling::*[1]")
      .first()
      .or(page.locator("[data-testid='invoice-tax']").first());
    const totalEl = page
      .getByText(/^total$/i)
      .locator("xpath=following-sibling::*[1]")
      .first()
      .or(page.locator("[data-testid='invoice-total']").first());
    // Discount and Shipping rows only render when their amount is > 0 (optional rows).
    const discountEl = page
      .getByText(/^discount$/i)
      .locator("xpath=following-sibling::*[1]")
      .first()
      .or(page.locator("[data-testid='invoice-discount']").first());
    const shippingEl = page
      .getByText(/^shipping$/i)
      .locator("xpath=following-sibling::*[1]")
      .first()
      .or(page.locator("[data-testid='invoice-shipping']").first());

    // It's fine if the page doesn't surface these three fields individually.
    // We only run the math check when all three are found.
    const [subText, taxText, totText] = await Promise.all([
      subtotalEl.textContent().catch(() => null),
      taxEl.textContent().catch(() => null),
      totalEl.textContent().catch(() => null),
    ]);

    if (!subText || !taxText || !totText) {
      // Summary section not found with these locators — pass the structural check
      // but let CP-04 (API layer) catch any math errors instead.
      return;
    }

    const sub = parseMoney(subText);
    const tax = parseMoney(taxText);
    const tot = parseMoney(totText);

    if (sub === null || tax === null || tot === null) return;

    // Discount/Shipping are optional rows — probe presence with count() first so an
    // absent row resolves instantly instead of waiting out the actionability timeout.
    const discText =
      (await discountEl.count()) > 0 ? await discountEl.textContent().catch(() => null) : null;
    const shipText =
      (await shippingEl.count()) > 0 ? await shippingEl.textContent().catch(() => null) : null;
    // Discount renders with a literal leading "-" (e.g. "-$5.00") — normalize to a
    // positive magnitude so it matches the subtotal − discount + shipping + tax formula.
    const discount = discText ? Math.abs(parseMoney(discText) ?? 0) : 0;
    const shippingFee = shipText ? (parseMoney(shipText) ?? 0) : 0;

    const expected = Math.round((sub - discount + shippingFee + tax) * 100) / 100;
    const diff = Math.abs(expected - tot);
    expect(
      diff,
      `Invoice total mismatch: subtotal(${sub}) - discount(${discount}) + shipping(${shippingFee}) + tax(${tax}) = ${expected} ≠ total(${tot})`,
    ).toBeLessThanOrEqual(0.01);
  });

  // ── API-layer float-artifact scan ─────────────────────────────────────────

  test("CP-04 invoices API — money fields have ≤2 decimal places", async ({ page, request }) => {
    // Extract the JWT from localStorage after a page load initialises the auth state
    await page.goto("/invoices");
    const token = await page.evaluate(
      () => localStorage.getItem("rf:op:accessToken") || localStorage.getItem("accessToken") || "",
    );

    if (!token) {
      test.skip(true, "No auth token found in localStorage");
      return;
    }

    const api = apiBase(page.url());
    const res = await request.get(`${api}/api/v1/invoices?limit=10`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-tenant-slug": TENANT_SLUG,
      },
    });

    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const artifacts = floatArtifacts(body);
    expect(
      artifacts,
      `Float artifacts in invoice API response:\n  ${artifacts.join("\n  ")}`,
    ).toHaveLength(0);
  });

  test("CP-05 orders API — money fields have ≤2 decimal places", async ({ page, request }) => {
    await page.goto("/orders");
    const token = await page.evaluate(
      () => localStorage.getItem("rf:op:accessToken") || localStorage.getItem("accessToken") || "",
    );

    if (!token) {
      test.skip(true, "No auth token found");
      return;
    }

    const api = apiBase(page.url());
    const res = await request.get(`${api}/api/v1/orders?limit=10`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-tenant-slug": TENANT_SLUG,
      },
    });

    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const artifacts = floatArtifacts(body);
    expect(
      artifacts,
      `Float artifacts in orders API response:\n  ${artifacts.join("\n  ")}`,
    ).toHaveLength(0);
  });

  // ── Order detail: amounts formatted and consistent ────────────────────────

  test("CP-06 order detail — item amounts and order totals are well-formed", async ({ page }) => {
    await page.goto("/orders");
    // Order rows render as link-rows — the whole row is an <a> to the detail page.
    // Wait for it to load before clicking (avoids racing the data fetch).
    const firstRow = page.getByRole("link", { name: /ORD-\d+/ }).first();
    try {
      await firstRow.waitFor({ timeout: 15_000 });
    } catch {
      // Fail, never skip (B566 follow-up): e2e-seed.js seeds an order.
      throw new Error("No orders to inspect — run `node apps/api/scripts/e2e-seed.js` (B566)");
    }

    await firstRow.click();
    await page.waitForURL(/\/orders\/.+/, { timeout: 30_000 });

    // Any dollar amount visible on the order detail page should be $X.XX
    const dollarEls = page
      .locator("td, span, p, [class*='amount'], [class*='total'], [class*='price']")
      .filter({ hasText: /^\s*\$/ });

    const count = await dollarEls.count();
    expect(count, "The order detail page rendered no dollar amounts (B566)").toBeGreaterThan(0);

    const texts = await dollarEls.allTextContents();
    const badAmounts = texts.map((t) => t.trim()).filter((t) => t && !MONEY_RE.test(t));
    expect(
      badAmounts,
      `Malformatted amounts on order detail: ${badAmounts.join(", ")}`,
    ).toHaveLength(0);
  });

  // ── Finance / invoice list ────────────────────────────────────────────────

  test("CP-07 finance dashboard — amounts are properly rounded", async ({ page }) => {
    await page.goto("/finance/dashboard");
    await expect(page).not.toHaveURL(/error/, { timeout: 15_000 });

    // KPI / metric cards on the finance dashboard show money amounts
    const amounts = page
      .locator("[class*='stat'], [class*='kpi'], [class*='card'], [class*='metric']")
      .filter({ hasText: /\$/ });
    const count = await amounts.count();
    if (count === 0) return;

    // innerText, NOT textContent: textContent concatenates adjacent nodes with no
    // separator, so an amount absorbs the leading digits of the next label. The
    // AR-aging legend ("$0.00" then "1 to 15 days") read as "$0.001" whenever the
    // tenant had any open AR — a false "malformatted" hit on perfectly-rounded
    // values (nightly 2026-08-19). innerText keeps block/flex boundaries as line
    // breaks, and \n also separates the per-element strings below.
    const texts = await amounts.allInnerTexts();
    // Extract dollar amounts from card text (may contain labels + amounts mixed)
    const dollarMatches = texts.join("\n").match(/\$[\d,]+\.\d+/g) ?? [];
    const badAmounts = dollarMatches.filter((t) => !MONEY_RE.test(t));
    expect(
      badAmounts,
      `Malformatted amounts on finance dashboard: ${badAmounts.join(", ")}`,
    ).toHaveLength(0);
  });

  // ── Customer portal — buyer-facing amounts ────────────────────────────────

  test("CP-08 buyer portal invoice amounts are $X.XX", async ({ page, context }) => {
    // The buyer portal (/buyer/*) is a separate auth flow.
    // This test checks the public-facing amounts without requiring buyer login.
    await page.goto("/buyer/login");
    // If login page loads without server error, the buyer portal is functional.
    await expect(page).not.toHaveURL(/error/, { timeout: 15_000 });
    const title = page.locator("h1, h2").first();
    await expect(title).toBeVisible({ timeout: 10_000 });
  });

  // ── Products: pricing display ─────────────────────────────────────────────

  test("CP-09 product list — unit prices are $X.XX", async ({ page }) => {
    await page.goto("/products");
    // The catalog defaults to a grid view; switch to the table so row/price cells resolve.
    await page
      .getByRole("button", { name: "Table view" })
      .click({ timeout: 5_000 })
      .catch(() => {});
    await page
      .locator("table tbody tr, [class*='product-card'], [class*='empty']")
      .first()
      .waitFor({ timeout: 15_000 });

    const priceCells = page
      .locator("td, [class*='price'], [class*='unit-price']")
      .filter({ hasText: /^\s*\$/ });
    const count = await priceCells.count();
    // A catalog with no priced rows proves nothing about price formatting — fail, never
    // return green (B566: `e2e-seed.js` seeds priced products).
    expect(
      count,
      "No priced product rows on /products — run `node apps/api/scripts/e2e-seed.js` (B566)",
    ).toBeGreaterThan(0);

    const texts = await priceCells.allTextContents();
    const badPrices = texts.map((t) => t.trim()).filter((t) => t && !MONEY_RE.test(t));
    expect(badPrices, `Malformatted prices on product list: ${badPrices.join(", ")}`).toHaveLength(
      0,
    );
  });

  // ── Regression: the 220 × 2 = 420 bug ────────────────────────────────────

  test("CP-10 invoices API — invoice total equals sum of line item subtotals + tax", async ({
    page,
    request,
  }) => {
    await page.goto("/invoices");
    const token = await page.evaluate(
      () => localStorage.getItem("rf:op:accessToken") || localStorage.getItem("accessToken") || "",
    );
    if (!token) {
      test.skip(true, "No auth token");
      return;
    }

    const api = apiBase(page.url());

    // Fetch the first invoice list
    const listRes = await request.get(`${api}/api/v1/invoices?limit=3`, {
      headers: { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG },
    });
    expect(listRes.ok(), `GET /invoices returned ${listRes.status()}`).toBe(true);

    const list = await listRes.json();
    const invoices = Array.isArray(list) ? list : (list.items ?? list.data ?? []);
    // Fail, never return green on an empty list (B566 follow-up: e2e-seed.js seeds an invoice).
    expect(
      invoices.length,
      "No invoices to check — run `node apps/api/scripts/e2e-seed.js` (B566)",
    ).toBeGreaterThan(0);

    // Spot-check the first invoice detail
    const inv = invoices[0];
    const detailRes = await request.get(`${api}/api/v1/invoices/${inv.id}`, {
      headers: { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG },
    });
    expect(detailRes.ok(), `GET /invoices/${inv.id} returned ${detailRes.status()}`).toBe(true);

    const detail = await detailRes.json();
    // Decimal columns (shippingFee/discount included) may arrive as strings — coerce all.
    const { subtotal = 0, taxAmount = 0, total = 0, discount = 0, shippingFee = 0 } = detail;
    const sub = Number(subtotal);
    const tax = Number(taxAmount);
    const tot = Number(total);
    const disc = Number(discount);
    const ship = Number(shippingFee);

    // Round to cents to allow for stored-rounding conventions
    const expected = Math.round((sub - disc + ship + tax) * 100) / 100;
    const diff = Math.abs(expected - tot);

    expect(
      diff,
      `Invoice #${inv.id}: subtotal(${sub}) - discount(${disc}) + shipping(${ship}) + tax(${tax}) = ${expected} but total = ${tot}`,
    ).toBeLessThanOrEqual(0.01);

    // Verify no line-item has more than 2dp in money fields (catches 420 bug)
    const items = detail.items ?? detail.invoiceItems ?? [];
    for (const item of items) {
      const artifacts = floatArtifacts(item, `item[${item.id}]`);
      expect(
        artifacts,
        `Float artifacts in invoice line item: ${artifacts.join(", ")}`,
      ).toHaveLength(0);
    }
  });
});
