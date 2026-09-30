/**
 * WP3 (16): Variant split UI — the "Assign to variants" modal
 * (`VariantSplitModal.tsx`), cancel-only.
 *
 * Role: OPERATOR. READ-ONLY-OR-CANCEL BY CONTRACT: opens the modal on a real
 * parent-with-variants product, types an over-large qty into one row to prove
 * the pool clamps rather than lets it overrun, then Cancels — the "Assign N
 * units" submit button is never clicked, so `POST /inventory/variant-assign`
 * never fires (asserted directly below) and no stock moves.
 *
 * Discovery: rather than paging through the products grid looking for a "N
 * var." badge, this reads the products list straight off the API
 * (`GET /products?includeVariants=true`, the same data the grid card badge
 * is built from) to find a non-variant product with at least one active
 * variant AND stock on hand — the product page passes that stock as the
 * modal's `pool`, and a zero pool would make the clamp assertion vacuous —
 * plus its `costingMethod`, which is what the STANDARD-cost assertion below
 * is conditioned on. `test.skip`s with a clear message when the tenant has
 * nothing suitable; feature-smoke.mjs does not provision a variant fixture,
 * so this spec must not assume one exists.
 */

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

const SKIP_REASON =
  "No parent product with an active variant AND stock on hand found on this tenant — the " +
  "variant-split UI has nothing to exercise (a zero pool clamps to nothing, so asserting the " +
  "over-assignment block against it would pass whether or not the clamp exists). " +
  "feature-smoke.mjs does not provision one; seed a stocked variant pair and re-run.";

const EMPTY_POOL_SKIP_REASON =
  "The variant parent reported no unassigned stock by the time the modal opened — with a pool " +
  "of 0 a clamped and an unclamped row are indistinguishable, so this spec refuses to green on " +
  "a vacuous check.";

interface ApiProduct {
  id: string;
  parentProductId: string | null;
  costingMethod?: string;
  currentStock?: number | string | null;
  variants?: Array<{ id: string }>;
}

test.describe("Operator — Variant split UI (WP3-16)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  /** Finds a non-variant product that has at least one active variant AND
   *  stock to split, via a direct, read-only API call — the same list the
   *  products grid's "N var." badge reads from, just without paging through
   *  it. The stock requirement is what gives the modal a non-zero pool, and
   *  therefore a clamp worth asserting. Returns null when the operator token
   *  is missing or the tenant has nothing suitable. */
  async function findVariantParent(
    page: Page,
    request: APIRequestContext,
  ): Promise<ApiProduct | null> {
    const token = await operatorAccessToken(page);
    if (!token) return null;
    const api = apiBase(page.url());
    const res = await request
      .get(`${api}/api/v1/products`, {
        params: { includeVariants: true, isActive: true, limit: 500 },
        headers: { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG },
      })
      .catch(() => null);
    if (!res || !res.ok()) return null;
    const body: { data?: ApiProduct[] } = await res.json();
    const products = body.data ?? [];
    // ≥ 1 whole unit of stock: the clamp truncates, so a sub-unit pool would
    // clamp every row to 0 and prove nothing.
    const candidate = products.find(
      (p) =>
        !p.parentProductId && (p.variants?.length ?? 0) > 0 && Number(p.currentStock ?? 0) >= 1,
    );
    return candidate ?? null;
  }

  test("VARIANT-01 Remaining pool renders, over-assignment clamps, Cancel never applies", async ({
    page,
    request,
  }) => {
    await page.goto("/products");

    const parent = await findVariantParent(page, request);
    if (!parent) {
      test.skip(true, SKIP_REASON);
      return;
    }

    // Guards the "never applies" contract independent of the DOM assertions below.
    let assignCalled = false;
    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      if (/\/api\/v1\/inventory\/variant-assign(\?.*)?$/.test(req.url())) assignCalled = true;
    });

    await page.goto(`/products/${parent.id}`);
    const assignButton = page.getByRole("button", { name: "Assign to variants" });
    await expect(assignButton).toBeVisible({ timeout: 15_000 });
    await assignButton.click();

    const heading = page.getByRole("heading", { name: "Assign to variants" });
    await expect(heading).toBeVisible({ timeout: 10_000 });
    // Nearest ancestor panel — needed because "Cost"/"Cancel" could otherwise
    // also resolve against the product page's own content sitting behind the
    // overlay (it isn't unmounted, just visually covered).
    const modal = heading.locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");

    // The Remaining pool renders.
    const remainingBadge = modal.getByText(/^Remaining: /);
    await expect(remainingBadge).toBeVisible();
    const beforeText = (await remainingBadge.textContent()) ?? "";
    const beforeMatch = beforeText.match(/(-?\d+(?:\.\d+)?)/);
    const totalPool = beforeMatch ? parseFloat(beforeMatch[1]) : NaN;
    expect(Number.isNaN(totalPool), `could not read a number out of "${beforeText}"`).toBe(false);
    // The pool is what the clamp clamps TO. Without one there is nothing to
    // prove, and every assertion below would pass unclamped as well.
    if (totalPool < 1) {
      test.skip(true, EMPTY_POOL_SKIP_REASON);
      return;
    }

    // Wait for the variant row(s) to actually load (vs. the "Loading
    // variants…" placeholder, which has no <input>) before touching one.
    const firstRow = modal.locator("tbody tr").first();
    const firstQtyInput = firstRow.locator('input[type="number"]').first();
    await expect(firstQtyInput).toBeVisible({ timeout: 15_000 });

    // Typing far above the pool CLAMPS rather than overruns it — works for
    // both the boxed (cases/pieces) and plain-qty row shapes: the boxed input
    // carries this title; the plain one doesn't.
    const boxesInput = firstRow.locator('input[title="Number of whole cases"]');
    if ((await boxesInput.count()) > 0) {
      await boxesInput.fill("9999");
    } else {
      await firstQtyInput.fill("9999");
    }

    // The clamp forces the assigned total down to exactly the pool (whole
    // units — it truncates), and the submit button's own label counts those
    // assigned units. That label is the only readout that DISCRIMINATES:
    // the Remaining badge is `Math.max(0, pool - assigned)` in the component,
    // so it renders 0 whether the clamp holds or has been deleted, whereas an
    // unclamped row would label the button "Assign 9999 units".
    const assignedUnits = Math.trunc(totalPool);
    const submitButton = modal.getByRole("button", { name: /^Assign(\s\d+\sunits?)?$/ });
    await expect(submitButton).toHaveText(
      `Assign ${assignedUnits} unit${assignedUnits === 1 ? "" : "s"}`,
      { timeout: 10_000 },
    );
    await expect(submitButton).toBeEnabled();

    // STANDARD-cost case: the per-row Cost field/column is hidden entirely.
    // Conditional on what the API said this parent's costingMethod actually
    // is — asserting it unconditionally would be guessing.
    if (parent.costingMethod === "STANDARD") {
      await expect(modal.getByText("Cost", { exact: true })).toHaveCount(0);
    }

    // Cancel — never submit.
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(heading).toHaveCount(0);
    expect(assignCalled).toBe(false);
  });
});
