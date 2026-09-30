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

    const productRes = await request.post(`${api}/api/v1/products`, {
      headers,
      data: { name: `E2E 2791 Widget ${suffix}`, unit: "unit", pricePerUnit: "5.00" },
    });
    expect(productRes.ok(), `POST /products ${productRes.status()}`).toBe(true);
    const product: { id: string } = await productRes.json();
    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers,
      data: {
        username: `e2e_2791_${suffix}`,
        businessName: `E2E 2791 Mirror ${suffix}`,
        contactName: "E2E Tester",
      },
    });
    expect(customerRes.ok(), `POST /customers ${customerRes.status()}`).toBe(true);
    const customer: { id: string } = (await customerRes.json()).customer;
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
    const order: { id: string; orderNumber?: string } = await orderRes.json();
    let invoiceId: string | undefined;

    try {
      // from-order returns an ARRAY of invoices (one per order / delivery batch).
      const fromOrder = await request.post(`${api}/api/v1/invoices/from-order/${order.id}`, {
        headers,
      });
      expect(fromOrder.ok(), `POST /invoices/from-order ${fromOrder.status()}`).toBe(true);
      const body = await fromOrder.json();
      const invoice: { id: string; status: string } = Array.isArray(body) ? body[0] : body;
      invoiceId = invoice.id;
      expect(invoice.status).toBe("DRAFT");

      // Proof capture only: PROOF_DIR + PROOF_VIEWPORT=WxH (local lane, never set in CI).
      const proofDir = process.env.PROOF_DIR;
      const vp = /^(\d+)x(\d+)$/.exec(process.env.PROOF_VIEWPORT ?? "");
      if (proofDir && vp) await page.setViewportSize({ width: +vp[1], height: +vp[2] });

      await page.goto(`/invoices/${invoice.id}/edit`);
      // Lands on the ORDER page (not a 404) ...
      await expect(page).toHaveURL(new RegExp(`/orders/${order.id}$`), { timeout: 15_000 });
      await expect(page.getByText(/this page could not be found/i)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Edit Items", exact: true })).toBeVisible({
        timeout: 15_000,
      });
      // ... and the reason is on screen (the toast survives the navigation).
      await expect(page.getByText(/This invoice mirrors order ORD-/i).first()).toBeVisible();
      await expect(page.getByText(/edit the order instead/i).first()).toBeVisible();
      await expect(page.getByRole("button", { name: /save changes/i })).toHaveCount(0);
      if (proofDir && vp) await page.screenshot({ path: `${proofDir}/order-page-${vp[1]}.png` });
    } finally {
      // Best-effort cleanup, children first, so the run leaves no residue.
      const del = (path: string) =>
        request.delete(`${api}/api/v1/${path}`, { headers }).catch(() => undefined);
      if (invoiceId) await del(`invoices/${invoiceId}`);
      await del(`orders/${order.id}`);
      await del(`customers/${customer.id}`);
      await del(`products/${product.id}`);
    }
  });
});
