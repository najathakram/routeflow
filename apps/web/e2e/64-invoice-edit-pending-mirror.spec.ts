/**
 * #2791 (ruled): an order-linked DRAFT invoice whose order is not yet delivered is a "pending mirror"
 * — the API refuses to edit it by design (the order is the source of truth until delivery). The detail
 * page hides Edit; /invoices/[id]/edit must apply the same predicate and send the operator to the
 * order edit page with a one-line reason, never an editable form whose save can only fail.
 *
 * Role: OPERATOR (pre-authenticated session). Tenant: the approved e2e-routeflow seed (assertTestTenant
 * in helpers/constants.ts). Creates a throwaway customer/product/PENDING order + its draft invoice and
 * deletes what it can in a `finally`.
 */
import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

test.describe("Invoice edit route — pending-mirror draft (#2791)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("/invoices/[id]/edit redirects a pending mirror to the order edit page with a readable reason", async ({
    page,
    request,
  }) => {
    await page.goto("/orders");
    await expect(page.getByRole("button", { name: "New Order" })).toBeVisible({ timeout: 15_000 });
    const token = await operatorAccessToken(page);
    expect(
      token,
      "no operator access token — stale storageState or setup did not run",
    ).toBeTruthy();
    const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
    const api = apiBase(page.url());
    const suffix = Date.now();

    const product = await (
      await request.post(`${api}/api/v1/products`, {
        headers,
        data: { name: `E2E 2791 Widget ${suffix}`, unit: "unit", pricePerUnit: "5.00" },
      })
    ).json();
    const customer = (
      await (
        await request.post(`${api}/api/v1/customers`, {
          headers,
          data: {
            username: `e2e_2791_${suffix}`,
            businessName: `E2E 2791 Mirror ${suffix}`,
            contactName: "E2E Tester",
          },
        })
      ).json()
    ).customer;
    const orderRes = await request.post(`${api}/api/v1/orders`, {
      headers,
      data: {
        customerId: customer.id,
        status: "PENDING",
        mergeChoice: "separate",
        items: [{ productId: product.id, qty: 2 }],
      },
    });
    expect(orderRes.ok(), `POST /orders ${orderRes.status()}`).toBe(true);
    const order: { id: string } = await orderRes.json();

    try {
      const fromOrder = await request.post(`${api}/api/v1/invoices/from-order/${order.id}`, {
        headers,
      });
      expect(fromOrder.ok(), `POST /invoices/from-order ${fromOrder.status()}`).toBe(true);
      const invoice: { id: string; status: string } = await fromOrder.json();
      expect(invoice.status).toBe("DRAFT");

      await page.goto(`/invoices/${invoice.id}/edit`);
      await expect(page).toHaveURL(new RegExp(`/orders/${order.id}/edit$`), { timeout: 15_000 });
      await expect(page.getByRole("button", { name: /save changes/i })).toHaveCount(0);
    } finally {
      await request.delete(`${api}/api/v1/orders/${order.id}`, { headers }).catch(() => undefined);
    }
  });
});
