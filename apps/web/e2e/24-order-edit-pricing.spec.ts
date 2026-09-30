/**
 * F06 — B62: order-edit pricing readiness gate (R11 / T15).
 *
 * REG-B62 — the order-edit page (`/orders/[id]`) auto-enters edit mode the
 * instant a DRAFT order loads, while its `useCustomer`/`useCustomerPrices`
 * queries for the order's customer are still in flight. Until this fix,
 * `customerTier` defaulted to `?? 1` in that window, so a line ADDED before
 * those queries settle bakes in the LIST price for a tier customer, and the
 * substitute flow is worse — it always SENDS its computed `unitPrice` to the
 * API, so the wrong price persists server-side. R11's fix: the add-product
 * control and the substitute trigger stay disabled (with a
 * "Loading customer pricing…" hint) until `pricingReady` — the customer
 * detail query settled AND the customer-prices query settled (success or
 * error; an error must not wedge the editor shut forever) — then price any
 * line added afterward at the resolved tier.
 *
 * This spec makes the race DETERMINISTIC by holding `GET /customers/:id`
 * behind a `page.route` gate instead of racing real network timing: assert
 * the gated (disabled) state while the gate is held, release it, assert the
 * enabled state, then add a tier-priced product and read its displayed unit
 * price straight off the DOM.
 *
 * T15, proven-pending-deploy (test-plan.md, campaign decision D1): this spec
 * is NOT part of F06's local red gate (`apps/web` has no unit runner for its
 * client-side query logic — see spec-plan §1). It runs against the DEPLOYED
 * site only, discharged by the deploy-triggered Playwright run once F06
 * ships; until then it is expected red (the add control is enabled
 * instantly and prices at list, exactly the bug this spec proves).
 *
 * Its `playwright.config.ts` project entry (mirroring "payment-truth" (22):
 * `dependencies: ["setup"]`, `storageState: operator.json`) is wired
 * separately below in this same commit — WITHOUT IT THE SPEC NEVER RUNS.
 *
 * Role: OPERATOR (reads its token out of the pre-authenticated session, same
 * as 21/22). Tenant: the approved e2e-routeflow regression seed (never a
 * live client — enforced by helpers/constants.ts's assertTestTenant at
 * import time). Fixtures are fully self-provisioned via the API — a
 * throwaway customer (`E2E B62 …`, pricingTier 2) and two throwaway products
 * (an "Anchor" line pre-loaded onto the order so the Substitute control has
 * something to render, and a "Tier" product carrying an explicit
 * `priceTier2` distinct from its list price) plus a DRAFT order for that
 * customer — resolved purely by the ids the API hands back. NEVER "the
 * first row" (the #556 lesson: 02-operator's OP-09c/OP-11b poisoned
 * themselves clicking the products list's first row, which another spec's
 * guard fixtures occupy under a newest-first sort): every record this spec
 * touches is created here, this run, and addressed only by its own id.
 * Nothing is cleaned up afterward — a DRAFT order + two inactive-catalog
 * products + a customer with `pricingTier: 2` are harmless residue on a
 * shared seed tenant, the same tolerance 21/22's own throwaway fixtures take.
 */

import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

/** Bearer + tenant headers for a direct API call, or null when unauthenticated. */
async function apiHeaders(
  page: Page,
): Promise<{ authorization: string; "x-tenant-slug": string } | null> {
  const token = await operatorAccessToken(page);
  if (!token) return null;
  return { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
}

test.describe("Order-edit pricing readiness (F06)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("REG-B62 add-product and substitute controls stay disabled until customer pricing resolves, then price the added line at the customer's tier, never list (R11 / T15)", async ({
    page,
    request,
  }) => {
    // Hydration entry wait, same signal every other operator-role spec in
    // this suite uses before touching localStorage or the API.
    await page.goto("/orders");
    await expect(page.getByRole("button", { name: "New Order" })).toBeVisible({
      timeout: 15_000,
    });

    const headers = await apiHeaders(page);
    // Hard failure, never a skip — consistent with every other fixture call in
    // this spec. A missing token is a stale operator storageState or a setup
    // project that did not run: an environment fault. Skipping on it would
    // report GREEN for a run that proved nothing, and R11 has no other
    // pre-merge evidence to fall back on.
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());
    const suffix = Date.now();

    // ── Fixture 1: the "Anchor" product — pre-loaded onto the order so a
    // Substitute trigger exists to assert against during the gated window.
    // Its own price is never asserted; only that it renders.
    const anchorRes = await request.post(`${api}/api/v1/products`, {
      headers: headers!,
      data: { name: `E2E B62 Anchor ${suffix}`, unit: "unit", pricePerUnit: "5.00" },
    });
    // Hard failure, never a skip: name/unit/pricePerUnit are CreateProductDto's
    // only required fields (21-destructive-guards' own precedent for this same
    // call), so a non-ok response is a broken fixture or environment
    // condition, not a data condition.
    expect(anchorRes.ok(), `POST /products (anchor) returned ${anchorRes.status()}`).toBe(true);
    const anchorProduct: { id: string; name: string } = await anchorRes.json();

    // ── Fixture 2: the "Tier" product — the one actually added mid-test.
    // priceTier2 is set to a value deliberately far from pricePerUnit (list)
    // so a line pricing at either one is unambiguous: 12.50 (tier) vs 20.00
    // (list) can never be confused for one another by a rounding accident.
    const tierListPrice = 20.0;
    const tier2Price = 12.5;
    const tierRes = await request.post(`${api}/api/v1/products`, {
      headers: headers!,
      data: {
        name: `E2E B62 Tier ${suffix}`,
        unit: "unit",
        pricePerUnit: tierListPrice.toFixed(2),
        priceTier2: tier2Price.toFixed(2),
      },
    });
    expect(tierRes.ok(), `POST /products (tier) returned ${tierRes.status()}`).toBe(true);
    const tierProduct: { id: string; name: string } = await tierRes.json();

    // ── Fixture 3: the customer — pricingTier 2 is the fallback the page
    // resolves to once `useCustomer` settles (getTierPrice(product, 2)); the
    // per-product CustomerPrice override below is redundant with it by
    // design (defence in depth — either path alone must already yield tier 2).
    const businessName = `E2E B62 Pricing Gate ${suffix}`;
    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers: headers!,
      data: {
        username: `e2e_b62_${suffix}`,
        businessName,
        contactName: "E2E Tester",
        pricingTier: 2,
      },
    });
    expect(customerRes.ok(), `POST /customers returned ${customerRes.status()}`).toBe(true);
    // POST /customers nests its result: { customer: {...} } (verified live by
    // 21-destructive-guards' REG-B130 case and 22-payment-truth's REG-B11 case).
    const customer: { id: string } = (await customerRes.json()).customer;
    expect(customer?.id, "POST /customers response carried no customer.id").toBeTruthy();

    // Explicit per-product tier override — matches how the operator tier
    // editor (02-operator's OP-09c) actually sets these rows. Not load-bearing
    // for the price outcome (the customer's own pricingTier already resolves
    // the same tier), but exercises the same CustomerPrice path R11's gate
    // was written against.
    const priceOverrideRes = await request.post(`${api}/api/v1/customers/${customer.id}/prices`, {
      headers: headers!,
      data: { productId: tierProduct.id, pricingTier: 2 },
    });
    expect(
      priceOverrideRes.ok(),
      `POST /customers/:id/prices returned ${priceOverrideRes.status()}`,
    ).toBe(true);

    // ── Fixture 4: the DRAFT order — carries the Anchor line from creation
    // (so Substitute has a target) but NOT the Tier product; that one is
    // added live, mid-test, through the gated UI control.
    const orderRes = await request.post(`${api}/api/v1/orders`, {
      headers: headers!,
      data: {
        customerId: customer.id,
        status: "DRAFT",
        items: [{ productId: anchorProduct.id, qty: 1 }],
      },
    });
    expect(orderRes.ok(), `POST /orders returned ${orderRes.status()}`).toBe(true);
    const order: { id: string } = await orderRes.json();
    expect(order?.id, "POST /orders response carried no id").toBeTruthy();

    // ── The gate: hold GET /customers/:id (the query R11's `pricingReady`
    // waits on) open until released below. Armed BEFORE navigation so the
    // hold is already in place when the order page's useCustomer query fires
    // — arming after goto() would race the real request.
    let releaseCustomerFetch: () => void = () => {};
    const customerFetchGate = new Promise<void>((resolve) => {
      releaseCustomerFetch = resolve;
    });
    await page.route(`**/customers/${customer.id}`, async (route) => {
      await customerFetchGate;
      await route.continue();
    });

    // ── Open the order. DRAFT auto-enters edit mode immediately (unchanged
    // by R11 — only the two pricing-dependent controls wait), independent of
    // the held customer query above.
    await page.goto(`/orders/${order.id}`);

    const addInput = page.getByPlaceholder("Scan barcode or type name…");
    const substituteButton = page.getByRole("button", { name: "Substitute", exact: true });
    const loadingHint = page.getByText("Loading customer pricing…", { exact: true });

    // ── Gated state: customer pricing still in flight.
    await expect(addInput).toBeVisible({ timeout: 15_000 });
    await expect(addInput).toBeDisabled({ timeout: 15_000 });
    await expect(loadingHint).toBeVisible({ timeout: 10_000 });
    await expect(substituteButton).toBeVisible({ timeout: 10_000 });
    await expect(substituteButton).toBeDisabled({ timeout: 10_000 });

    // ── Release the hold. Customer pricing resolves; the gate opens.
    releaseCustomerFetch();

    await expect(addInput).toBeEnabled({ timeout: 15_000 });
    await expect(loadingHint).toHaveCount(0, { timeout: 10_000 });
    await expect(substituteButton).toBeEnabled({ timeout: 10_000 });

    // ── Add the Tier product through the (now-enabled) scan/search input.
    await addInput.fill(tierProduct.name);
    // Scoped to the add-row's own dropdown wrapper (the `relative`-positioned
    // ancestor `page.tsx` gives `addRef`) rather than the whole page, so this
    // can never collide with the identically-named line the click is about
    // to create just below it.
    const addRow = addInput.locator("xpath=ancestor::div[contains(@class,'relative')][1]");
    const dropdownOption = addRow.getByRole("button").filter({ hasText: tierProduct.name });
    await expect(dropdownOption).toBeVisible({ timeout: 10_000 });
    await dropdownOption.click();
    // The dropdown unmounts entirely on selection — wait for it to be gone
    // before searching the page for the product name again below, so the
    // now-added line's own text can never be confused with a lingering
    // dropdown row still showing the same name.
    await expect(addRow.locator("ul")).toHaveCount(0, { timeout: 10_000 });

    // ── The proof: the new line's displayed unit price is the seeded tier-2
    // price (12.50), never the list price (20.00) a pre-R11 page would have
    // shown while pricing context loaded (this line was added only AFTER the
    // gate opened, but priced list unless `pricingReady` actually gated the
    // control against DOING the add too early in the first place).
    const newLineName = page.getByText(tierProduct.name, { exact: true });
    await expect(newLineName).toBeVisible({ timeout: 10_000 });
    // Nearest ancestor <div> that also contains a "Unit price" label — the
    // per-line wrapper `page.tsx` renders around each item's name AND its
    // PriceEditRow (a sibling block), found by content rather than a
    // hardcoded ancestor depth so it survives an unrelated markup reflow.
    const newLineRow = newLineName.locator(
      'xpath=ancestor::div[.//*[normalize-space(text())="Unit price"]][1]',
    );
    const unitPriceInput = newLineRow
      .getByText("Unit price", { exact: true })
      .locator("xpath=..//input");
    await expect(unitPriceInput).toHaveValue(tier2Price.toFixed(2), { timeout: 10_000 });
  });
});
