/**
 * I-101 E2E row: the Pallet level of the #3918 ladder, sold through the UI, end to end (local compose, test tenant,
 * flag.units_v1 on, OBSERVE-ONLY: it records what the build does and fixes nothing).
 *
 * Fixture, built through the real units API on a throwaway product: pack 10 pieces at 20.00 a box (piece 2.00), Case = 200
 * pieces (20 packs), Pallet = 4,800 pieces (24 Cases). Customer: "E2E Fixture Deli Three" (as 53/54).
 *
 * New sale on /invoices/new: pick Pallet, count 2 -> the row shows 9,600 pieces at "= $19,200.00". After Create sale & invoice:
 *   - the ORDER line reads unitLabel Pallet, qty 9600, boxes 2, unitsPerBox 4800, subtotal 19200;
 *   - the INVOICE made from it carries the same;
 *   - the invoice page shows the Pallet label to staff ("2 Pallets").
 * Money is asserted from the saved rows (server truth), not from the screen alone.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
const CUSTOMER_NAME = "E2E Fixture Deli Three";
const RUN = Date.now();
const PRODUCT_NAME = `E2E I101 Ladder ${RUN}`;

async function headersOf(page: Page) {
  const token = await operatorAccessToken(page);
  expect(token, "no operator access token: operator storageState is stale").toBeTruthy();
  return { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
}

interface Line {
  unitLabel?: string | null;
  qty: number | string;
  boxes?: number | string | null;
  unitsPerBox?: number | string | null;
  unitPrice?: number | string;
  subtotal: number | string;
}

const shapeOf = (l: Line) => ({
  unitLabel: l.unitLabel ?? null,
  qty: Number(l.qty),
  boxes: Number(l.boxes),
  unitsPerBox: Number(l.unitsPerBox),
  subtotal: Number(l.subtotal),
});
const PALLET_SHAPE = {
  unitLabel: "Pallet",
  qty: 9600,
  boxes: 2,
  unitsPerBox: 4800,
  subtotal: 19200,
};

test.describe("I-101: a Pallet of the 10/200/4800 ladder, sold in the UI", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("Pallet x 2 = 9,600 pieces at 19,200.00 on the order, the invoice, and the invoice page", async ({
    page,
    request,
  }) => {
    await page.goto("/orders");
    await expect(page.getByRole("button", { name: "New Order" })).toBeVisible({ timeout: 15_000 });
    const headers = await headersOf(page);
    const api = apiBase(page.url());

    // Fixture through the real API: the pack, then Case, then Pallet (parent = Case).
    const productRes = await request.post(`${api}/api/v1/products`, {
      headers,
      data: { name: PRODUCT_NAME, unit: "box", pricePerUnit: "20.00", unitsPerBox: 10 },
    });
    expect(productRes.ok(), `POST /products ${productRes.status()}`).toBe(true);
    const productId = ((await productRes.json()) as { id: string }).id;
    const caseRes = await request.post(`${api}/api/v1/products/${productId}/units`, {
      headers,
      data: { label: "Case", factorToBase: 200, perParent: 20 },
    });
    expect(caseRes.ok(), `POST units Case ${caseRes.status()}: ${await caseRes.text()}`).toBe(true);
    const caseId = ((await caseRes.json()) as { id: string }).id;
    const palletRes = await request.post(`${api}/api/v1/products/${productId}/units`, {
      headers,
      data: { label: "Pallet", factorToBase: 4800, parentUnitId: caseId, perParent: 24 },
    });
    expect(
      palletRes.ok(),
      `POST units Pallet ${palletRes.status()}: ${await palletRes.text()}`,
    ).toBe(true);

    // New sale: add the product, pick Pallet, count 2.
    await page.goto("/invoices/new");
    await page.getByRole("button", { name: /new sale/i }).click();
    await page.getByPlaceholder(/search customers/i).click();
    await page.getByPlaceholder(/search customers/i).fill(CUSTOMER_NAME);
    await page.getByText(CUSTOMER_NAME, { exact: true }).first().click();
    await page.getByPlaceholder(/scan barcode, or type product name/i).fill(PRODUCT_NAME);
    await page
      .getByRole("listbox")
      .getByRole("button", { name: new RegExp(PRODUCT_NAME) })
      .click();
    await expect(page.locator(`input[value="${PRODUCT_NAME}"]`)).toBeVisible();
    const picker = page.getByRole("combobox", { name: `Sell ${PRODUCT_NAME} by` });
    await picker.selectOption("Pallet");
    await page.getByLabel("Pallet count").fill("2");
    await expect(page.getByTestId("level-count")).toContainText(/9,?600 pcs/);
    await expect(page.getByText(/= \$19,?200\.00/)).toBeVisible();
    await page.screenshot({ path: "test-results/i101-pallet-row.png" });

    await page.getByRole("button", { name: /create sale & invoice/i }).click();
    await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{8,}/, { timeout: 20_000 });
    const invoiceId = page.url().split("/").pop()!;

    // Invoice truth, then the order it was made from.
    const invoice = await (
      await request.get(`${api}/api/v1/invoices/${invoiceId}`, { headers })
    ).json();
    expect(invoice.items).toHaveLength(1);
    expect(shapeOf(invoice.items[0])).toEqual(PALLET_SHAPE);
    expect(invoice.orderId, "the invoice carries no orderId").toBeTruthy();
    const order = await (
      await request.get(`${api}/api/v1/orders/${invoice.orderId}`, { headers })
    ).json();
    const orderLines = (order.lineItems ?? order.items) as Line[];
    expect(orderLines).toHaveLength(1);
    expect(shapeOf(orderLines[0])).toEqual(PALLET_SHAPE);

    // Staff see the Pallet label on the invoice page.
    await expect(page.getByText(/2 Pallets?/).first()).toBeVisible();
    await page.screenshot({ path: "test-results/i101-pallet-invoice.png" });
  });
});
