/**
 * WP2 (13): Boxed order entry — cases/pieces proration read live off the order
 * builder UI, never hardcoded.
 *
 * Role: OPERATOR (pre-authed via the "operator" Playwright project storage
 * state). READ-ONLY BY CONTRACT: builds one real line item to read its
 * rendered total, then Escapes out — it never places the order. Escaping with
 * a customer selected auto-parks a draft (the same ESC-02 behavior
 * 08-create-order-escape.spec.ts exercises), so this spec captures the
 * POST /drafts id and deletes it in afterEach, mirroring that spec's cleanup
 * exactly — no row survives the run.
 *
 * Discovery: the tenant's boxed product is found by probing the product
 * search with a few common terms and adding the first candidate whose row
 * exposes the cases/pieces inputs, removing every non-boxed candidate tried
 * along the way. `feature-smoke.mjs` provisions a boxed product on every run,
 * but this spec must not depend on suite ordering — it skips with a clear
 * message when none turns up.
 */

import { test, expect, type Page, type Locator } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

const PRODUCT_SEARCH_PLACEHOLDER = "Search by name, SKU or scan barcode…";
const SKIP_REASON =
  "No boxed product (cases/pieces) found on this tenant — feature-smoke.mjs provisions one; " +
  "run it, or seed a boxed product, then re-run.";

test.describe("Operator — Boxed order entry (WP2-13)", () => {
  // Escaping a started order (customer selected) auto-parks a real draft on
  // the tenant — same mechanism 08-create-order-escape.spec.ts's afterEach
  // cleans up. Capture the id from the builder's POST /drafts and delete it,
  // so the run leaves no residue in the operator's draft dock.
  const parkedDraftIds: string[] = [];
  const pendingParks: Array<Promise<void>> = [];

  test.beforeEach(async ({ page, context }) => {
    await setTenantCookie(context, BASE);
    page.on("response", (resp) => {
      if (resp.request().method() !== "POST") return;
      if (!/\/api\/v1\/drafts(\?.*)?$/.test(resp.url())) return;
      pendingParks.push(
        resp
          .json()
          .then((body: { id?: string }) => {
            if (resp.ok() && body?.id) parkedDraftIds.push(body.id);
          })
          .catch(() => {}),
      );
    });
    await page.goto("/orders");
  });

  test.afterEach(async ({ page, request }) => {
    await Promise.all(pendingParks.splice(0));
    const ids = parkedDraftIds.splice(0);
    if (ids.length === 0) return;
    const token = await operatorAccessToken(page);
    if (!token) return;
    const api = apiBase(page.url());
    for (const id of ids) {
      await request
        .delete(`${api}/api/v1/drafts/${id}`, {
          headers: { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG },
        })
        .catch(() => {});
    }
  });

  /** Opens the builder and picks the first customer — same flow as 08-create-order-escape. */
  async function openBuilderWithCustomer(page: Page) {
    await page
      .getByRole("button", { name: /new order/i })
      .first()
      .click();
    const title = page.getByRole("heading", { name: "Create Order" });
    await expect(title).toBeVisible({ timeout: 10_000 });
    // First row, data-agnostic: "e" matches most seeded business names.
    await page.getByPlaceholder("Search by business name…").fill("e");
    await page
      .locator('input[placeholder="Search by business name…"] ~ ul li button')
      .first()
      .click({ timeout: 10_000 });
    return title;
  }

  /** Waits for the product search's GET request for `term` to land. */
  function waitForProductSearch(page: Page, term: string) {
    return page
      .waitForResponse(
        (r) =>
          r.url().includes("/products?") &&
          r.url().includes(`search=${encodeURIComponent(term)}`) &&
          r.request().method() === "GET",
        { timeout: 8_000 },
      )
      .catch(() => null);
  }

  /**
   * Probes the product search with a handful of common terms, adding each
   * candidate row in turn and checking for the cases/pieces inputs; removes
   * and moves on when a candidate turns out not to be boxed. Returns the
   * boxed line's <li> locator, or null when nothing boxed turned up.
   */
  async function findBoxedLine(page: Page): Promise<Locator | null> {
    const search = page.getByPlaceholder(PRODUCT_SEARCH_PLACEHOLDER);
    const dropdownButtons = page
      .locator(`input[placeholder="${PRODUCT_SEARCH_PLACEHOLDER}"] ~ ul > li > button`)
      .filter({ hasNotText: "Create new product" });

    for (const term of ["case", "a", "e", "o"]) {
      let requested = waitForProductSearch(page, term);
      await search.fill(term);
      await requested;

      const count = await dropdownButtons.count();
      for (let i = 0; i < Math.min(count, 5); i++) {
        const btn = dropdownButtons.nth(i);
        const label = await btn.innerText().catch(() => "");
        if (/\bvariants?\b/i.test(label)) continue; // expands a parent, never adds a line

        await btn.click();
        const row = page.locator("ul.divide-y > li").last();
        const boxesInput = row.locator('input[title="Number of whole cases"]');
        if (await boxesInput.isVisible().catch(() => false)) return row;

        await row.getByTitle("Remove").click();
        // Re-open the same result set for the next candidate index.
        requested = waitForProductSearch(page, term);
        await search.fill(term);
        await requested;
      }
    }
    return null;
  }

  /** Reads the case price and pack size straight off the line row's own text. */
  async function readBoxedFacts(row: Locator): Promise<{ boxPrice: number; unitsPerBox: number }> {
    const text = await row.innerText();
    const priceMatches = Array.from(text.matchAll(/\$([\d,]+\.\d{2})\s*\/\s*([A-Za-z]+)/g));
    // Skip the "$X.XX / piece" derived-price line — the case/box price line
    // (li.unitPrice) always renders first, but matching on the unit word
    // rather than position keeps this safe against markup reordering.
    const priceMatch = priceMatches.find((m) => m[2].toLowerCase() !== "piece");
    const packMatch = text.match(/1 case = (\d+) units?/);
    if (!priceMatch || !packMatch) {
      throw new Error(`Could not read box price / pack size off the row:\n${text}`);
    }
    return {
      boxPrice: parseFloat(priceMatch[1].replace(/,/g, "")),
      unitsPerBox: parseInt(packMatch[1], 10),
    };
  }

  async function readLineTotal(row: Locator): Promise<number> {
    const text = (await row.locator("span.w-16").innerText()).trim();
    const value = parseFloat(text.replace(/[$,]/g, ""));
    expect(Number.isNaN(value), `line total text was not a number: "${text}"`).toBe(false);
    return value;
  }

  /** Polls the line total until it prorates to `boxPrice × (boxes + pieces/unitsPerBox)`. */
  async function assertLineTotal(
    row: Locator,
    boxPrice: number,
    unitsPerBox: number,
    boxes: number,
    pieces: number,
  ) {
    const expected = Math.round(boxPrice * (boxes + pieces / unitsPerBox) * 100) / 100;
    await expect
      .poll(async () => Math.abs((await readLineTotal(row)) - expected), { timeout: 10_000 })
      .toBeLessThanOrEqual(0.01);
  }

  test("BOXED-01 pieces-only and mixed boxed lines prorate to the cent, read live off the page", async ({
    page,
  }) => {
    const title = await openBuilderWithCustomer(page);

    const row = await findBoxedLine(page);
    if (row === null) {
      test.skip(true, SKIP_REASON);
      return;
    }

    const { boxPrice, unitsPerBox } = await readBoxedFacts(row);
    const boxesInput = row.locator('input[title="Number of whole cases"]');
    const piecesInput = row.locator('input[title="Extra loose units (less than a full case)"]');

    // Pieces-only: 0 cases + 2 loose units.
    await boxesInput.fill("0");
    await piecesInput.fill("2");
    await assertLineTotal(row, boxPrice, unitsPerBox, 0, 2);

    // Mixed: 1 case + 2 loose units.
    await boxesInput.fill("1");
    await assertLineTotal(row, boxPrice, unitsPerBox, 1, 2);

    // Escape out — no add-item sub-flow is active (search cleared, no custom
    // form open), so this single Escape falls through to the dismiss/park
    // path exactly like ESC-02 in 08-create-order-escape.spec.ts. The order
    // is never placed.
    await page.keyboard.press("Escape");
    await expect(title).toBeHidden({ timeout: 10_000 });
    await expect(page.getByText(/saved as draft|draft parked/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
