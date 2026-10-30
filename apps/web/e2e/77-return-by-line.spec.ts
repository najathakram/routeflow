/**
 * SA-1042 B9c: a return is counted line by line, in the unit the line was sold in. The form asks for Cases and pcs; the
 * person never does the pieces arithmetic, and the server converts, caps and prices.
 *
 * Fixture through the real API on a throwaway product and customer: pack 10 at 2.50 a box, Case = 200 pieces at its own
 * 45.00. The order is 2 Cases (400 pcs, 90.00), delivered, which invoices it.
 *
 * Through the UI: New Return, count 1 Case, Create Return. The detail page reads "200 pcs (1 Case)". Then approve,
 * in transit, received, and Resolve Return as store credit, which mints a 45.00 credit note. Money is read from the saved
 * rows (server truth) as well as the screen.
 *
 * Role: OPERATOR. Tenant: the approved e2e-routeflow seed, with flag.units_v1 granted by e2e-seed.js. It CREATES a
 * product, a customer, an invoice and a credit note with no cleanup, so the project is local lane only. The local-target
 * guard (local web + API + DB, not GitHub Actions, approved test tenant) and assertTestTenant run before the first write.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";
import { assertLocalFulfilmentTarget } from "../lib/local-fulfilment-guard";
import { localTarget } from "./helpers/local-fulfilment-profile";

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const RUN = Date.now();
const PRODUCT_NAME = `E2E Return Case ${RUN}`;
const CUSTOMER_NAME = `E2E Return Customer ${RUN}`;

async function headersOf(page: Page) {
  const token = await operatorAccessToken(page);
  expect(token, "no operator access token: operator storageState is stale").toBeTruthy();
  return { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
}

test.describe("SA-1042 B9c: a return counted by line", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("1 Case through the form reads 200 pcs (1 Case) and credits 45.00", async ({
    page,
    request,
  }) => {
    assertLocalFulfilmentTarget(localTarget(apiBase(BASE)));
    assertTestTenant(TENANT_SLUG, "spec 77 throwaway fixtures");

    await page.goto("/returns");
    await expect(page.getByRole("button", { name: "New Return" })).toBeVisible({ timeout: 15_000 });
    const headers = await headersOf(page);
    const api = apiBase(page.url());

    const productRes = await request.post(`${api}/api/v1/products`, {
      headers,
      data: { name: PRODUCT_NAME, unit: "box", pricePerUnit: "2.50", unitsPerBox: 10 },
    });
    expect(productRes.ok(), `POST /products ${productRes.status()}`).toBe(true);
    const productId = ((await productRes.json()) as { id: string }).id;
    const caseRes = await request.post(`${api}/api/v1/products/${productId}/units`, {
      headers,
      data: { label: "Case", factorToBase: 200, perParent: 20, price: 45 },
    });
    expect(caseRes.ok(), `POST units Case ${caseRes.status()}: ${await caseRes.text()}`).toBe(true);

    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers,
      data: {
        username: `e2e-return-${RUN}`,
        businessName: CUSTOMER_NAME,
        contactName: "E2E Return",
      },
    });
    expect(customerRes.ok(), `POST /customers ${customerRes.status()}`).toBe(true);
    const customerId = ((await customerRes.json()) as { customer: { id: string } }).customer.id;

    const orderRes = await request.post(`${api}/api/v1/orders`, {
      headers,
      data: {
        customerId,
        status: "PENDING",
        mergeChoice: "separate",
        items: [{ productId, unitLabel: "Case", qty: 2 }],
      },
    });
    expect(orderRes.ok(), `POST /orders ${orderRes.status()}: ${await orderRes.text()}`).toBe(true);
    const order = (await orderRes.json()) as { id: string; orderNumber: string };
    for (const status of ["CONFIRMED", "DELIVERED"]) {
      const res = await request.patch(`${api}/api/v1/orders/${order.id}/status`, {
        headers,
        data: { status },
      });
      expect(res.ok(), `PATCH status ${status} ${res.status()}: ${await res.text()}`).toBe(true);
    }

    // The form: customer, the delivered order, a reason, then the count in the line's own unit.
    await page.getByRole("button", { name: "New Return" }).click();
    const form = page.locator("#create-return-form");
    await form.getByPlaceholder("Search customers…").fill(CUSTOMER_NAME);
    const selects = form.locator("select");
    await expect(selects.nth(0).locator("option", { hasText: CUSTOMER_NAME })).toHaveCount(1, {
      timeout: 15_000,
    });
    await selects.nth(0).selectOption({ label: CUSTOMER_NAME });
    await expect(selects.nth(1).locator("option", { hasText: order.orderNumber })).toHaveCount(1, {
      timeout: 15_000,
    });
    await selects.nth(1).selectOption({ label: order.orderNumber });
    await selects.nth(2).selectOption({ label: "Damaged" });

    await form.getByLabel(`Cases to return, ${PRODUCT_NAME}`).fill("1");
    await expect(form.getByLabel(`pcs to return, ${PRODUCT_NAME}`)).toBeVisible();

    // No sideways swipe to reach a count, its unit words or Notes, on a desktop or a phone.
    const table = form.getByTestId("return-lines-table");
    const fits = () => table.evaluate((el) => el.scrollWidth <= el.clientWidth);
    expect(await fits()).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await fits()).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });

    const [created] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === "POST" && /\/api\/v1\/returns\/?$/.test(r.url()),
      ),
      page.getByRole("button", { name: "Create Return" }).click(),
    ]);
    expect(created.ok(), `POST /returns ${created.status()}`).toBe(true);
    const returnId = ((await created.json()) as { id: string }).id;

    // Read back in the line's own unit, on the screen and in the saved row.
    await page.goto(`/returns/${returnId}`);
    await expect(page.getByText("200 pcs (1 Case)").first()).toBeVisible({ timeout: 15_000 });
    const saved = (await (
      await request.get(`${api}/api/v1/returns/${returnId}`, { headers })
    ).json()) as { items: { qty: number | string }[] };
    expect(saved.items).toHaveLength(1);
    expect(Number(saved.items[0]!.qty)).toBe(200);

    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await page.getByRole("button", { name: "Approve Return" }).click();
    await page.getByRole("button", { name: "Mark In Transit" }).click();
    await page.getByRole("button", { name: "Mark Received" }).click();
    await page.getByRole("button", { name: "Resolve Return" }).click();

    const resolve = page.getByRole("dialog");
    await resolve.getByRole("radio", { name: /Issue store credit/ }).check();
    await expect(resolve.getByText(/Mints a \$45\.00 credit note/)).toBeVisible();
    await resolve.getByRole("button", { name: "Resolve Return" }).click();

    await expect(page.getByText("Return fully processed.")).toBeVisible({ timeout: 15_000 });
    const resolved = (await (
      await request.get(`${api}/api/v1/returns/${returnId}`, { headers })
    ).json()) as { refundAmount: number | string; creditNoteId: string | null };
    expect(Number(resolved.refundAmount)).toBe(45);
    expect(resolved.creditNoteId, "no credit note on the resolved return").toBeTruthy();
    const creditNote = (await (
      await request.get(`${api}/api/v1/credit-notes/${resolved.creditNoteId}`, { headers })
    ).json()) as { amount: number | string };
    expect(Number(creditNote.amount)).toBe(45);
  });
});
