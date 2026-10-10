/**
 * units_v1 deploy gate (#2233, ruling SA-390) — a Case line survives the whole order →
 * order-edit → invoice lane with BASE-PIECE fixtures throughout (ruling SA-388: every
 * stored qty is count × factor):
 *   create (API) → server truth (boxes 3 / qty 36 / unitsPerBox 12) → order detail UI
 *   shows "3 Cases" → a price-only edit THROUGH THE WEB UI leaves qty/boxes unchanged →
 *   invoice-from-order (API) → invoice detail UI shows the unit too.
 *
 * Fixture (apps/api/scripts/e2e-seed.js `ensureUnitsFixture`, #2195): the e2e-routeflow
 * tenant holds a `flag.units_v1` GRANT (TenantFeatureOverride) and product SKU
 * "E2E-FIX-UNITS" ("E2E Fixture Units Widget", unit "Piece", no pack, pricePerUnit
 * $2.00) carries a ProductUnit row {label: "Case", factorToBase: 12, price: $21.00}.
 * The customer fixture ("E2E Fixture Deli Three") is the same one 13-boxed-order-entry
 * uses. A missing flag/product/unit/customer is a HARD FAILURE naming the seed script —
 * never `test.skip` (see 13-boxed-order-entry's MISSING_FIXTURE posture) — a skipped run
 * would report green having proven nothing about units_v1.
 *
 * Every record is resolved by an id the API handed back — never "the first row" (the
 * #556 lesson 24-order-edit-pricing's own header cites).
 *
 * STRUCTURE: three independent tests, each creating its own Case order through the API
 * (`createCaseOrder`, which also asserts the stored base-piece truth). The price-only edit is
 * its own test so an edit can never revert the invoice the invoice test reads
 * (`OrdersService.updateOrderItems` → `revertLinkedInvoicesForOrderEdit`). It is the #2305
 * regression gate (a typed price on a units_v1 line survived nowhere before #2380).
 *
 * Read-only display is asserted at the PAGE level ("3 Cases" appears once, since the
 * order/invoice created here carries exactly one line), not via a `<tr>` ancestor —
 * `orderUiV2` can swap `OrderLineItemsTable` (a `<table>`) for `OrderLineItemCards` (a
 * `<div>` list) on the READ-ONLY order view, and a row-shape-specific locator would
 * silently stop proving anything the day that flag flips. Both render the line's qty
 * through the same shared formatter (`invoiceLineQtyText` / `formatQtySplit` with the
 * unit as `boxLabel`), so the text itself does not vary. The EDIT-mode markup
 * (`PriceEditRow`/`EditableLineItems`) is NOT flag-gated, so the price-input locator
 * below (mirrors 24-order-edit-pricing's own xpath-from-"Unit price" pattern) is safe.
 *
 * Residue: leaves one PENDING order + one invoice on e2e-routeflow — the same
 * no-cleanup tolerance 21/22/24's own throwaway fixtures take (neither resource has an
 * API delete).
 */

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

const UNITS_SKU = "E2E-FIX-UNITS";
const UNITS_PRODUCT_NAME = "E2E Fixture Units Widget";
const UNITS_CUSTOMER_NAME = "E2E Fixture Deli Three";
const SEED_HINT =
  "`node apps/api/scripts/e2e-seed.js` (#2195) seeds the units_v1 fixture — run it, then re-run.";

interface OrderLine {
  id: string;
  productId: string | null;
  unitLabel?: string | null;
  boxes?: number | null;
  pieces?: number | null;
  qty: number | string;
  unitsPerBox?: number | null;
  unitPrice: number | string;
  subtotal: number | string;
}

interface OrderPayload {
  id: string;
  orderNumber: string;
  lineItems: OrderLine[];
}

/** Bearer + tenant headers for a direct API call, or null when unauthenticated — mirrors
 *  24-order-edit-pricing's own helper. */
async function apiHeaders(
  page: Page,
): Promise<{ authorization: string; "x-tenant-slug": string } | null> {
  const token = await operatorAccessToken(page);
  if (!token) return null;
  return { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
}

/** Resolves the fixture by SKU/name, creates ONE PENDING order with a Case line (count 3) through
 *  the API, and asserts the server truth in base pieces (SA-388). Every test calls it, so each one
 *  owns its own order and none depends on another's side effects. */
// #2305 only reproduces on a TIERED catalog (a price ladder on the product AND on the Case level;
// the customer stays tier 1). The lane sets that ladder itself before each test and restores exactly
// what it found afterwards, so it always covers the tiered path whatever the shared tenant holds.
type TierKey = "priceTier2" | "priceTier3" | "priceTier4" | "priceTier5";
const TIER_KEYS: TierKey[] = ["priceTier2", "priceTier3", "priceTier4", "priceTier5"];
const PRODUCT_TIERS: Record<TierKey, string> = {
  priceTier2: "1.90",
  priceTier3: "1.80",
  priceTier4: "1.70",
  priceTier5: "1.60",
};
const CASE_TIERS: Record<TierKey, number> = {
  priceTier2: 20,
  priceTier3: 19,
  priceTier4: 18,
  priceTier5: 17,
};

interface SavedLadder {
  api: string;
  headers: { authorization: string; "x-tenant-slug": string };
  productId: string;
  unitId: string;
  /** Product tiers are non-null Decimals (default 0) — restored as the strings read back. */
  product: Record<TierKey, string>;
  /** Unit tiers are nullable — null restores "derived". */
  unit: Record<TierKey, number | null>;
}

/** Reads the fixture's current tier prices, then applies the lane's ladder. */
async function applyTierLadder(page: Page, request: APIRequestContext): Promise<SavedLadder> {
  await page.goto("/orders");
  await expect(page.getByRole("button", { name: "New Order" })).toBeVisible({ timeout: 15_000 });
  const headers = await apiHeaders(page);
  expect(headers, "no operator access token — operator storageState is stale").toBeTruthy();
  const api = apiBase(page.url());

  const listRes = await request.get(
    `${api}/api/v1/products?search=${encodeURIComponent(UNITS_SKU)}`,
    { headers: headers! },
  );
  expect(listRes.ok(), `GET /products?search returned ${listRes.status()}`).toBe(true);
  const listBody = await listRes.json();
  const rows = (listBody.data ?? listBody.products ?? listBody) as Array<{
    id: string;
    sku?: string;
  }>;
  const listed = rows.find?.((p) => p.sku === UNITS_SKU);
  expect(listed, `Fixture product SKU "${UNITS_SKU}" not found — ${SEED_HINT}`).toBeTruthy();

  const productRes = await request.get(`${api}/api/v1/products/${listed!.id}`, {
    headers: headers!,
  });
  expect(productRes.ok(), `GET /products/:id returned ${productRes.status()}`).toBe(true);
  const product = (await productRes.json()) as Record<TierKey, string | number>;

  const unitsRes = await request.get(`${api}/api/v1/products/${listed!.id}/units`, {
    headers: headers!,
  });
  expect(unitsRes.ok(), `GET /products/:id/units returned ${unitsRes.status()}`).toBe(true);
  const caseUnit = (
    (await unitsRes.json()) as Array<
      { id: string; label: string } & Record<TierKey, string | number | null>
    >
  ).find((u) => u.label === "Case");
  expect(caseUnit, `Fixture product "${UNITS_SKU}" has no "Case" unit — ${SEED_HINT}`).toBeTruthy();

  const saved: SavedLadder = {
    api,
    headers: headers!,
    productId: listed!.id,
    unitId: caseUnit!.id,
    product: Object.fromEntries(TIER_KEYS.map((k) => [k, String(product[k] ?? "0")])) as Record<
      TierKey,
      string
    >,
    unit: Object.fromEntries(
      TIER_KEYS.map((k) => [k, caseUnit![k] == null ? null : Number(caseUnit![k])]),
    ) as Record<TierKey, number | null>,
  };

  const setProduct = await request.patch(`${api}/api/v1/products/${saved.productId}`, {
    headers: saved.headers,
    data: PRODUCT_TIERS,
  });
  expect(setProduct.ok(), `PATCH /products/:id (tiers) returned ${setProduct.status()}`).toBe(true);
  const setUnit = await request.patch(
    `${api}/api/v1/products/${saved.productId}/units/${saved.unitId}`,
    { headers: saved.headers, data: CASE_TIERS },
  );
  expect(
    setUnit.ok(),
    `PATCH /products/:id/units/:unitId (tiers) returned ${setUnit.status()}`,
  ).toBe(true);
  return saved;
}

/** Puts back exactly the tier prices `applyTierLadder` read. */
async function restoreTierLadder(request: APIRequestContext, saved: SavedLadder): Promise<void> {
  const product = await request.patch(`${saved.api}/api/v1/products/${saved.productId}`, {
    headers: saved.headers,
    data: saved.product,
  });
  expect(product.ok(), `restore PATCH /products/:id returned ${product.status()}`).toBe(true);
  const unit = await request.patch(
    `${saved.api}/api/v1/products/${saved.productId}/units/${saved.unitId}`,
    { headers: saved.headers, data: saved.unit },
  );
  expect(unit.ok(), `restore PATCH /products/:id/units/:unitId returned ${unit.status()}`).toBe(
    true,
  );
}

async function createCaseOrder(page: Page, request: APIRequestContext) {
  // Hydration entry wait — same signal 24-order-edit-pricing uses before touching
  // localStorage or the API.
  await page.goto("/orders");
  await expect(page.getByRole("button", { name: "New Order" })).toBeVisible({ timeout: 15_000 });

  const headers = await apiHeaders(page);
  expect(
    headers,
    "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
  ).toBeTruthy();
  const api = apiBase(page.url());

  // ── The fixture product, BY SKU (never "the first row") ──────────────────────
  const productRes = await request.get(
    `${api}/api/v1/products?search=${encodeURIComponent(UNITS_SKU)}`,
    { headers: headers! },
  );
  expect(productRes.ok(), `GET /products?search returned ${productRes.status()}`).toBe(true);
  const productBody = await productRes.json();
  const productRows = (productBody.data ?? productBody.products ?? productBody) as Array<{
    id: string;
    sku?: string;
  }>;
  const product = productRows.find?.((p) => p.sku === UNITS_SKU);
  expect(
    product,
    `Fixture product SKU "${UNITS_SKU}" not found on this tenant — ${SEED_HINT}`,
  ).toBeTruthy();

  // ── Its ladder must carry a Case unit at factor 12 ───────────────────────────
  const unitsRes = await request.get(`${api}/api/v1/products/${product!.id}/units`, {
    headers: headers!,
  });
  expect(unitsRes.ok(), `GET /products/:id/units returned ${unitsRes.status()}`).toBe(true);
  const units = (await unitsRes.json()) as Array<{ label: string; factorToBase: number }>;
  const caseUnit = units.find((u) => u.label === "Case");
  expect(caseUnit, `Fixture product "${UNITS_SKU}" has no "Case" unit — ${SEED_HINT}`).toBeTruthy();
  expect(caseUnit!.factorToBase).toBe(12);

  // ── The fixture customer, BY EXACT NAME ──────────────────────────────────────
  const customerRes = await request.get(
    `${api}/api/v1/customers?search=${encodeURIComponent(UNITS_CUSTOMER_NAME)}`,
    { headers: headers! },
  );
  expect(customerRes.ok(), `GET /customers?search returned ${customerRes.status()}`).toBe(true);
  const customerBody = await customerRes.json();
  const customerRows = (customerBody.data ?? customerBody.customers ?? customerBody) as Array<{
    id: string;
    businessName?: string;
  }>;
  const customer = customerRows.find?.((c) => c.businessName === UNITS_CUSTOMER_NAME);
  expect(
    customer,
    `Fixture customer "${UNITS_CUSTOMER_NAME}" not found on this tenant — ${SEED_HINT}`,
  ).toBeTruthy();

  // ── ONE Case line, count 3 (unit-line-build.ts: input qty on a unit line is the COUNT) ──
  const orderRes = await request.post(`${api}/api/v1/orders`, {
    headers: headers!,
    data: {
      customerId: customer!.id,
      status: "PENDING",
      forceNew: true,
      items: [{ productId: product!.id, qty: 3, unitLabel: "Case" }],
    },
  });
  expect(orderRes.ok(), `POST /orders returned ${orderRes.status()}`).toBe(true);
  const created: OrderPayload = await orderRes.json();
  expect(created?.id, "POST /orders response carried no id").toBeTruthy();

  async function fetchOrder(): Promise<OrderPayload> {
    const res = await request.get(`${api}/api/v1/orders/${created.id}`, { headers: headers! });
    expect(res.ok(), `GET /orders/:id returned ${res.status()}`).toBe(true);
    return res.json();
  }
  function findLine(order: OrderPayload): OrderLine {
    const line = order.lineItems.find((li) => li.productId === product!.id);
    expect(line, "order carries no line for the fixture product").toBeTruthy();
    return line!;
  }

  // ── Server truth (SA-388): BASE PIECES — boxes = count, qty = count × factor ──
  const order = await fetchOrder();
  const line = findLine(order);
  expect(line.unitLabel).toBe("Case");
  expect(Number(line.boxes)).toBe(3);
  expect(Number(line.qty)).toBe(36); // 3 × 12 base pieces
  expect(Number(line.unitsPerBox)).toBe(12);
  expect(Number(line.unitPrice)).toBe(21); // the ladder's Case price ($21.00)
  expect(Number(line.subtotal)).toBe(63); // 3 × $21.00

  return { api, headers: headers!, orderId: created.id, order, fetchOrder, findLine };
}

test.describe("Units v1 — order → edit → invoice lane (#2233 / SA-390)", () => {
  // Serial: every test sets and restores the same product's tier ladder.
  test.describe.configure({ mode: "serial" });
  let saved: SavedLadder | null = null;

  test.beforeEach(async ({ context, page, request }) => {
    await setTenantCookie(context, BASE);
    saved = await applyTierLadder(page, request);
  });

  test.afterEach(async ({ request }) => {
    if (saved) await restoreTierLadder(request, saved);
    saved = null;
  });

  test('a Case line is stored in base pieces and the order detail shows "3 Cases" (SA-388)', async ({
    page,
    request,
  }) => {
    const { orderId, order } = await createCaseOrder(page, request);

    await page.goto(`/orders/${orderId}`);
    // The order number renders twice (the top bar's h1 and the page header's h2) — this is only a
    // load wait, so either is fine.
    await expect(page.getByRole("heading", { name: order.orderNumber }).first()).toBeVisible({
      timeout: 15_000,
    });
    const main = page.locator("#main-content");
    await expect(main.getByText(UNITS_PRODUCT_NAME, { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
    // The line reads "3 Cases · $21.00 / Case of 12" as one text node — a word match.
    await expect(main.getByText(/\b3 Cases\b/).first()).toBeVisible({ timeout: 10_000 });
  });

  test('invoice-from-order carries the unit: the invoice detail shows "3 Cases"', async ({
    page,
    request,
  }) => {
    const { api, headers, orderId } = await createCaseOrder(page, request);

    // (apps/api/src/invoices/invoices.controller.ts POST /invoices/from-order/:orderId)
    const invoiceRes = await request.post(`${api}/api/v1/invoices/from-order/${orderId}`, {
      headers,
    });
    expect(
      invoiceRes.ok(),
      `POST /invoices/from-order/:orderId returned ${invoiceRes.status()}`,
    ).toBe(true);
    const invoiceBody = await invoiceRes.json();
    // createInvoiceFromOrder returns an array (W4 regulated-category split) — a plain catalog line
    // never splits, but the shape is read defensively.
    const invoices = (Array.isArray(invoiceBody) ? invoiceBody : [invoiceBody]) as Array<{
      id: string;
      invoiceNumber: string;
    }>;
    expect(invoices.length, "createInvoiceFromOrder returned no invoice").toBeGreaterThan(0);
    const invoice = invoices[0];

    await page.goto(`/invoices/${invoice.id}`);
    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: invoice.invoiceNumber }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(main.getByText(UNITS_PRODUCT_NAME, { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(main.getByText(/\b3 Cases\b/).first()).toBeVisible({ timeout: 10_000 });
  });

  // #2305 (fixed by #2380): before the fix, OrderLineUnitPicker's tier-refresh effect re-applied the
  // ladder price whenever the line's price differed, so the typed price was overwritten, the edit
  // total stayed $63.00, and Save sent no request.
  test("a price-only edit THROUGH THE WEB UI saves the new price and leaves qty/boxes unchanged (SA-388)", async ({
    page,
    request,
  }) => {
    const { orderId, order, fetchOrder, findLine } = await createCaseOrder(page, request);

    await page.goto(`/orders/${orderId}`);
    await expect(page.getByRole("heading", { name: order.orderNumber }).first()).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Edit Items" }).click();
    await expect(page.getByRole("button", { name: "Save Changes" })).toBeVisible({
      timeout: 10_000,
    });

    // Nearest ancestor <div> that also contains a "Unit price" label — the pattern
    // 24-order-edit-pricing.spec.ts uses to scope PriceEditRow's input to THIS line.
    const editRow = page
      .getByText(UNITS_PRODUCT_NAME, { exact: true })
      .locator('xpath=ancestor::div[.//*[normalize-space(text())="Unit price"]][1]');
    const unitPriceInput = editRow
      .getByText("Unit price", { exact: true })
      .locator("xpath=..//input");
    await expect(unitPriceInput).toHaveValue("21.00", { timeout: 10_000 });
    await unitPriceInput.fill("24.00");
    await expect(unitPriceInput).toHaveValue("24.00");

    const patchItemsResponse = page.waitForResponse(
      (r) => r.url().includes(`/orders/${orderId}/items`) && r.request().method() === "PATCH",
      { timeout: 15_000 },
    );
    await page.getByRole("button", { name: "Save Changes" }).click();
    const patchRes = await patchItemsResponse;
    expect(patchRes.ok(), `PATCH /orders/:id/items returned ${patchRes.status()}`).toBe(true);
    await expect(page.getByRole("button", { name: "Edit Items" })).toBeVisible({
      timeout: 10_000,
    });

    // Server truth after the price-only edit: qty/boxes UNCHANGED, price + subtotal moved.
    const line = findLine(await fetchOrder());
    expect(Number(line.boxes)).toBe(3);
    expect(Number(line.qty)).toBe(36);
    expect(line.unitLabel).toBe("Case");
    expect(Number(line.unitPrice)).toBe(24);
    expect(Number(line.subtotal)).toBe(72); // 3 × $24.00
  });
});
