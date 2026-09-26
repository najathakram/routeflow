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
 * ORDERING (deviates from the issue's literal list, which reads "invoice" before "a
 * price-only edit"): `OrdersService.updateOrderItems` calls
 * `invoicesService.revertLinkedInvoicesForOrderEdit` on every edit of an order that
 * already carries a linked invoice (orders.service.ts:3050/4932) — editing AFTER
 * invoicing would revert/void the very invoice step (f) needs to still show the unit.
 * So the price-only edit runs BEFORE invoicing (step e, then f): the invoice is created
 * from the order's FINAL state, exactly like an operator correcting a price before
 * billing a customer. `buildItemUpdates`/`buildEditItemFromLine` (orders/[id]/page.tsx)
 * are the "unit-line-lock" logic named in the brief — there is no separate
 * `unit-line-lock.tsx` file in this codebase; both live directly in `page.tsx`.
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

import { test, expect, type Page } from "@playwright/test";
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

test.describe("Units v1 — order → edit → invoice lane (#2233 / SA-390)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("a Case line survives create, order-edit UI display, a price-only edit, and invoice-from-order — base pieces throughout (SA-388)", async ({
    page,
    request,
  }) => {
    // Hydration entry wait — same signal 24-order-edit-pricing uses before touching
    // localStorage or the API.
    await page.goto("/orders");
    await expect(page.getByRole("button", { name: "New Order" })).toBeVisible({
      timeout: 15_000,
    });

    const headers = await apiHeaders(page);
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());

    // ── Resolve the fixture product BY SKU (never "the first row") ──────────────
    const productRes = await request.get(
      `${api}/api/v1/products?search=${encodeURIComponent(UNITS_SKU)}`,
      { headers: headers! },
    );
    expect(productRes.ok(), `GET /products?search returned ${productRes.status()}`).toBe(true);
    const productBody = await productRes.json();
    const productRows = (productBody.data ?? productBody.products ?? productBody) as Array<{
      id: string;
      sku?: string;
      name?: string;
    }>;
    const product = productRows.find?.((p) => p.sku === UNITS_SKU);
    expect(
      product,
      `Fixture product SKU "${UNITS_SKU}" not found on this tenant — ${SEED_HINT}`,
    ).toBeTruthy();

    // ── Its ladder must carry a Case unit at factor 12 ───────────────────────────
    // (apps/api/src/products/product-units.controller.ts:21 GET /products/:productId/units)
    const unitsRes = await request.get(`${api}/api/v1/products/${product!.id}/units`, {
      headers: headers!,
    });
    expect(unitsRes.ok(), `GET /products/:id/units returned ${unitsRes.status()}`).toBe(true);
    const units = (await unitsRes.json()) as Array<{ label: string; factorToBase: number }>;
    const caseUnit = units.find((u) => u.label === "Case");
    expect(
      caseUnit,
      `Fixture product "${UNITS_SKU}" has no "Case" unit — ${SEED_HINT}`,
    ).toBeTruthy();
    expect(caseUnit!.factorToBase).toBe(12);

    // ── Resolve the fixture customer BY EXACT NAME ───────────────────────────────
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

    // ── Create the order: ONE Case line, count 3 ─────────────────────────────────
    // unit-line-build.ts: input `qty` on a unit-aware line is the COUNT of the unit
    // (3 = three Cases), never expanded pieces. `forceNew` skips the
    // MERGE_CHOICE_REQUIRED 409 a leftover active order for this shared fixture
    // customer could otherwise trigger (a unit line already sets skipAutoMerge
    // server-side — see orders.create-units.spec.ts — forceNew just makes the
    // intent explicit at the call site).
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
    const orderId = created.id;

    async function fetchOrder(): Promise<OrderPayload> {
      const res = await request.get(`${api}/api/v1/orders/${orderId}`, { headers: headers! });
      expect(res.ok(), `GET /orders/:id returned ${res.status()}`).toBe(true);
      return res.json();
    }
    function findLine(order: OrderPayload): OrderLine {
      const line = order.lineItems.find((li) => li.productId === product!.id);
      expect(line, "order carries no line for the fixture product").toBeTruthy();
      return line!;
    }

    // ── Server truth (SA-388): stored in BASE PIECES — boxes = count, qty = count × factor ──
    let order = await fetchOrder();
    let line = findLine(order);
    expect(line.unitLabel).toBe("Case");
    expect(Number(line.boxes)).toBe(3);
    expect(Number(line.qty)).toBe(36); // 3 × 12 base pieces
    expect(Number(line.unitsPerBox)).toBe(12);
    expect(Number(line.unitPrice)).toBe(21); // the ladder's Case price ($21.00)
    expect(Number(line.subtotal)).toBe(63); // 3 × $21.00

    // ── UI: order detail shows "3 Cases" ─────────────────────────────────────────
    // (OrderLineItemsTable.tsx:78 / OrderLineItemCards.tsx, both via the shared
    // qty-text formatter — see the header comment on why this asserts at the page
    // level rather than via a row-shape-specific locator.)
    await page.goto(`/orders/${orderId}`);
    await expect(page.getByRole("heading", { name: order.orderNumber })).toBeVisible({
      timeout: 15_000,
    });
    const mainContent = page.locator("#main-content");
    await expect(mainContent.getByText(UNITS_PRODUCT_NAME, { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(mainContent.getByText("3 Cases", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // ── UI price-only edit (SA-388 path: unit-line-lock logic in page.tsx —
    // buildEditItemFromLine seeds `qty` to the COUNT (boxes ?? qty), never expanded
    // pieces; buildItemUpdates sends `{ id, action: "UPDATE", qty: <same count>,
    // unitLabel, productId, unitPrice }` on a price-only change) ──────────────────
    await page.getByRole("button", { name: "Edit Items" }).click();
    await expect(page.getByRole("button", { name: "Save Changes" })).toBeVisible({
      timeout: 10_000,
    });

    // Nearest ancestor <div> that also contains a "Unit price" label — the exact
    // pattern 24-order-edit-pricing.spec.ts uses to scope PriceEditRow's input to
    // THIS line without depending on markup depth.
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

    // ── Server truth after the price-only edit: qty/boxes UNCHANGED, price + subtotal moved ──
    order = await fetchOrder();
    line = findLine(order);
    expect(Number(line.boxes)).toBe(3);
    expect(Number(line.qty)).toBe(36);
    expect(line.unitLabel).toBe("Case");
    expect(Number(line.unitPrice)).toBe(24);
    expect(Number(line.subtotal)).toBe(72); // 3 × $24.00

    // ── Invoice-from-order — created from the order's FINAL (post-edit) state ───
    // (apps/api/src/invoices/invoices.controller.ts:57 POST /invoices/from-order/:orderId)
    const invoiceRes = await request.post(`${api}/api/v1/invoices/from-order/${orderId}`, {
      headers: headers!,
    });
    expect(
      invoiceRes.ok(),
      `POST /invoices/from-order/:orderId returned ${invoiceRes.status()}`,
    ).toBe(true);
    const invoiceBody = await invoiceRes.json();
    // createInvoiceFromOrder returns an array of invoices (W4 regulated-category
    // split) — a plain catalog line never splits, so this is a one-element array,
    // but the shape is read defensively rather than assumed.
    const invoices = (Array.isArray(invoiceBody) ? invoiceBody : [invoiceBody]) as Array<{
      id: string;
      invoiceNumber: string;
    }>;
    expect(invoices.length, "createInvoiceFromOrder returned no invoice").toBeGreaterThan(0);
    const invoice = invoices[0];
    expect(invoice?.id, "invoice carried no id").toBeTruthy();

    // ── UI: invoice detail shows the unit too ────────────────────────────────────
    // (apps/web/app/(dashboard)/invoices/[id]/page.tsx:2532, same shared formatter)
    await page.goto(`/invoices/${invoice.id}`);
    await expect(
      page.locator("#main-content").getByRole("heading", { name: invoice.invoiceNumber }),
    ).toBeVisible({ timeout: 15_000 });
    const invoiceMain = page.locator("#main-content");
    await expect(invoiceMain.getByText(UNITS_PRODUCT_NAME, { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(invoiceMain.getByText("3 Cases", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // No cleanup: a PENDING order + its invoice on the shared e2e-routeflow tenant
    // is the same harmless-residue tolerance 21-destructive-guards/22-payment-truth/
    // 24-order-edit-pricing's own throwaway fixtures take — neither resource has an
    // API delete.
  });
});
