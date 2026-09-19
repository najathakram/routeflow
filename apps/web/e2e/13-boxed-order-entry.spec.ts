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
 * along the way. `apps/api/scripts/e2e-seed.js` seeds a boxed product (B566) and
 * `feature-smoke.mjs` provisions one on every run; this spec must not depend on suite
 * ordering, and a missing fixture is a FAILURE (B566), never a skip — a skipped run
 * reports green having proven nothing about boxed proration.
 */

import { test, expect, type Page, type Locator } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

const PRODUCT_SEARCH_PLACEHOLDER = "Search by name, SKU or scan barcode…";
const MISSING_FIXTURE =
  "No boxed product (cases/pieces) found on this tenant — `node apps/api/scripts/e2e-seed.js` " +
  "seeds one (B566); run it, then re-run.";

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
    const lines = page.locator("ul.divide-y > li");
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
        // The line renders a tick after the click. `isVisible()` is a single
        // non-retrying probe, so reading it straight off the click meant a slow
        // render answered "not boxed" — and the boxed product was then REMOVED
        // and skipped, leaving the spec to self-skip green on a tenant that does
        // have one. Wait for the row to render before judging it.
        //
        // Waited on the ROW, deliberately not on `toHaveCount(1)` over the whole
        // page: `ul.divide-y` is not unique to this modal (orders/[id] and
        // CreditNotePicker render the same class combo), so a page-wide count
        // assertion would be a latent false RED the day one of those is mounted
        // behind the modal. Row-visibility fixes the same race without that coupling.
        const row = lines.last();
        await expect(row).toBeVisible({ timeout: 10_000 });
        const boxesInput = row.locator('input[title="Number of whole cases"]');
        if (await boxesInput.isVisible().catch(() => false)) return row;

        await row.getByTitle("Remove").click();
        await expect(row).toBeHidden({ timeout: 10_000 });
        // Re-open the same result set for the next candidate index.
        requested = waitForProductSearch(page, term);
        await search.fill(term);
        await requested;
      }
    }
    return null;
  }

  /**
   * Waits out the builder's post-add re-focus of the product search.
   *
   * `CreateOrderModal#addLineItem` clears the search and then re-focuses it on a
   * `setTimeout(…, 50)` so a wedge scanner can fire the next code. Playwright's
   * `fill()` on an `input[type=number]` is TWO round trips — first an in-page
   * `select() + focus()`, then a separate CDP `Input.insertText` — and
   * `insertText` goes to whatever is focused when it lands. When that 50 ms
   * re-focus falls between the two, the keystroke is delivered to the SEARCH box
   * (which then holds a stray "0") and the qty input keeps its old value, with
   * no error: `fill()` never reads the value back. The line total then stays on
   * the previous quantity forever and the money poll below burns its full
   * timeout — the exact master-CI failure this guard removes (verified by
   * replaying the steal: cases input stayed "1", search took the "0", total sat
   * at 1 case + 2 pieces instead of 2 pieces).
   *
   * Waiting for the search to be empty AND focused proves that timer has already
   * fired, so nothing is left pending to steal the keystrokes that follow.
   */
  async function waitForPostAddRefocus(page: Page) {
    const search = page.getByPlaceholder(PRODUCT_SEARCH_PLACEHOLDER);
    await expect(search).toHaveValue("", { timeout: 10_000 });
    await expect(search).toBeFocused({ timeout: 10_000 });
  }

  /**
   * Types a quantity into one of the row's boxed inputs and does not return
   * until the input actually holds it. `fill()` alone is fire-and-forget (see
   * `waitForPostAddRefocus`), so a swallowed keystroke is re-typed here rather
   * than surfacing 10 s later as an unexplained money mismatch. This asserts
   * only the INPUT, never the total — the proration assertion stays untouched.
   */
  async function setBoxedQty(page: Page, input: Locator, value: string) {
    const search = page.getByPlaceholder(PRODUCT_SEARCH_PLACEHOLDER);
    await expect(async () => {
      // Never leave a stolen keystroke sitting in the search box: it re-opens the
      // product dropdown, which would swallow this test's closing Escape.
      if ((await search.inputValue()) !== "") await search.fill("");
      await input.fill(value);
      await expect(input).toHaveValue(value, { timeout: 2_000 });
    }).toPass({ timeout: 15_000, intervals: [100, 250, 500, 1_000] });
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
    // Gate the money poll on the piece count the row renders from `li.qty` —
    // the SAME state `computeLineSubtotal` prices, and a value that provably
    // changes between the two cases below (2 pcs, then unitsPerBox + 2). Once it
    // reads the new quantity, React has committed the typed input and the poll
    // can no longer sample a pre-commit render of the old total. This asserts the
    // QUANTITY only: wrong proration still fails the assertion that follows.
    //
    // Anchored with \b rather than a bare substring: "2 pcs total" is a substring
    // of "12 pcs total", so on a tenant whose unitsPerBox ends in 0 the mixed case
    // would satisfy the pieces-only gate and stop guarding the stolen-keystroke
    // mode it exists for. \b cannot match between "1" and "2" (both word chars).
    const totalPieces = boxes * unitsPerBox + pieces;
    await expect(row).toContainText(new RegExp(String.raw`\b${totalPieces} pcs total`), {
      timeout: 10_000,
    });
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
    // Hard failure, never a skip (B566): the seed provisions the boxed product.
    expect(row, MISSING_FIXTURE).not.toBeNull();
    if (row === null) return; // narrows the type; unreachable after the expect above

    // Let the builder's post-add re-focus land before typing into the row.
    await waitForPostAddRefocus(page);

    const { boxPrice, unitsPerBox } = await readBoxedFacts(row);
    const boxesInput = row.locator('input[title="Number of whole cases"]');
    const piecesInput = row.locator('input[title="Extra loose units (less than a full case)"]');

    // Pieces-only: 0 cases + 2 loose units.
    await setBoxedQty(page, boxesInput, "0");
    await setBoxedQty(page, piecesInput, "2");
    await assertLineTotal(row, boxPrice, unitsPerBox, 0, 2);

    // Mixed: 1 case + 2 loose units.
    await setBoxedQty(page, boxesInput, "1");
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
