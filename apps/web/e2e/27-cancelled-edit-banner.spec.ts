/**
 * F07 — the "editing closed" banner on the operator order detail page
 * (T22 / R17 / REG-B10).
 *
 * REG-B10 — the server closes the edit window for a CANCELLED order and says
 * why: `editWindow = { editable: false, closedReason: "STATUS" }`
 * (orders.service.ts `computeEditWindow`, :502-507). The operator order page
 * drops the "Edit Items" button on that signal, but its explanation pill only
 * renders for `closedReason === "DISPATCHED"` — a value an OPERATOR response
 * never carries. The result today: on a cancelled order the operator sees the
 * edit control silently vanish with nothing telling them why.
 *
 * This spec proves the STATUS branch, which is the one an operator can actually
 * reach. (`"DISPATCHED"` is buyer semantics — `computeEditWindow` only emits it
 * for `role === CUSTOMER` — so no operator-role spec can exercise it; the
 * ux-spec keeps that string unchanged for robustness rather than as a claim
 * this suite can test.)
 *
 * T2, proven-pending-deploy (test-plan.md): it runs against the DEPLOYED site,
 * never locally in this pipeline, and it is deliberately NOT part of the jest
 * red gate — a banner is a rendered surface with no web unit runner behind it
 * (campaign decision D1). It IS expected red against a pre-F07 build, with no
 * self-skip on a missing banner: "the pill is absent" is precisely the
 * regression this spec exists to catch.
 *
 * ⚠️ Per test-plan.md, NEVER run `npx playwright test` for this file in any
 * form — not even `--list`. It clobbers `.campaign/runs/web-e2e.json`. The
 * spec is typechecked by `apps/web`'s `check-types` and run only by the
 * deploy-signal pipeline.
 *
 * Role: OPERATOR (reads its token out of the pre-authenticated session, same as
 * 21-destructive-guards / 22-payment-truth / 24-order-edit-pricing). Tenant:
 * the approved e2e-routeflow regression seed — never a live client (enforced by
 * helpers/constants.ts's assertTestTenant at import time).
 *
 * Net tenant state is zero: the spec creates its own throwaway customer,
 * product and PENDING order, and the `finally` block API-deletes the order
 * (CANCELLED is deletable for staff — orders.service.ts :5198-5211). Creating
 * the PENDING order decrements the throwaway product by 1; the F07 cancel is
 * what gives that unit back (R4), so on a fixed build nothing is left behind
 * but an unused customer and product — the same residue tolerance
 * 21/22/24 already take.
 */

import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

/** The exact banner copy R17 requires for `closedReason: "STATUS"`. */
const CANCELLED_BANNER = "Order cancelled — editing closed";
/** The buyer-semantics string that must NOT be reused for a cancelled order. */
const DISPATCHED_BANNER = "Out for delivery — editing closed";

/** Bearer + tenant headers for a direct API call, or null when unauthenticated. */
async function apiHeaders(
  page: Page,
): Promise<{ authorization: string; "x-tenant-slug": string } | null> {
  const token = await operatorAccessToken(page);
  if (!token) return null;
  return { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
}

test.describe("Cancelled-order editing-closed banner (F07 / B10)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("REG-B10 a cancelled order's detail page explains why editing is closed instead of silently dropping the Edit Items button (R17 / T22)", async ({
    page,
    request,
  }) => {
    // Hydration entry wait — the same signal every other operator-role spec in
    // this suite uses before touching localStorage or the API.
    await page.goto("/orders");
    await expect(page.getByRole("button", { name: "New Order" })).toBeVisible({
      timeout: 15_000,
    });

    const headers = await apiHeaders(page);
    // Hard failure, never a skip: a missing token is a stale operator
    // storageState or a setup project that did not run — an environment fault.
    // Skipping would report GREEN for a run that proved nothing, and R17 has no
    // other evidence to fall back on.
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());
    const suffix = Date.now();

    // ── Fixture 1: a throwaway product. name/unit/pricePerUnit are
    // CreateProductDto's only required fields (21-destructive-guards' precedent
    // for this same call).
    const productRes = await request.post(`${api}/api/v1/products`, {
      headers: headers!,
      data: { name: `E2E B10 Widget ${suffix}`, unit: "unit", pricePerUnit: "5.00" },
    });
    expect(productRes.ok(), `POST /products returned ${productRes.status()}`).toBe(true);
    const product: { id: string } = await productRes.json();
    expect(product?.id, "POST /products response carried no id").toBeTruthy();

    // ── Fixture 2: a throwaway customer, so no pre-existing open order of a
    // shared seed customer can trigger the MERGE_CHOICE_REQUIRED 409 below.
    const customerRes = await request.post(`${api}/api/v1/customers`, {
      headers: headers!,
      data: {
        username: `e2e_b10_${suffix}`,
        businessName: `E2E B10 Cancel Banner ${suffix}`,
        contactName: "E2E Tester",
      },
    });
    expect(customerRes.ok(), `POST /customers returned ${customerRes.status()}`).toBe(true);
    // POST /customers nests its result: { customer: {...} } (verified live by
    // 21-destructive-guards' REG-B130 case and 22-payment-truth's REG-B11 case).
    const customer: { id: string } = (await customerRes.json()).customer;
    expect(customer?.id, "POST /customers response carried no customer.id").toBeTruthy();

    // ── Fixture 3: a PENDING order (NOT a draft — the page auto-enters edit
    // mode for a DRAFT, which hides "Edit Items" for an unrelated reason and
    // would make the pre-cancel control assertion below meaningless).
    // `mergeChoice: "separate"` sets skipAutoMerge so the consolidation sweep
    // cannot fold this order into another one mid-test.
    const orderRes = await request.post(`${api}/api/v1/orders`, {
      headers: headers!,
      data: {
        customerId: customer.id,
        status: "PENDING",
        mergeChoice: "separate",
        items: [{ productId: product.id, qty: 1 }],
      },
    });
    expect(orderRes.ok(), `POST /orders returned ${orderRes.status()}`).toBe(true);
    const order: { id: string } = await orderRes.json();
    expect(order?.id, "POST /orders response carried no id").toBeTruthy();

    const editItemsButton = page.getByRole("button", { name: "Edit Items", exact: true });
    const cancelledBanner = page.getByText(CANCELLED_BANNER, { exact: true });

    try {
      // ── Pre-condition: while the order is live, the operator HAS the edit
      // control and there is no closed-window explanation. Without this half,
      // "Edit Items is hidden" after the cancel would be satisfied by a page
      // that never rendered the button at all.
      await page.goto(`/orders/${order.id}`);
      await expect(editItemsButton).toBeVisible({ timeout: 15_000 });
      await expect(cancelledBanner).toHaveCount(0);

      // ── Cancel. Nothing has been delivered on this order, so R2's
      // delivered-goods gate allows it; PENDING → CANCELLED is not a demotion,
      // so no `reason` is required.
      const cancelRes = await request.patch(`${api}/api/v1/orders/${order.id}/status`, {
        headers: headers!,
        data: { status: "CANCELLED" },
      });
      expect(
        cancelRes.ok(),
        `PATCH /orders/:id/status (CANCELLED) returned ${cancelRes.status()}`,
      ).toBe(true);

      // ── R17: the window is closed with `closedReason: "STATUS"`, and the
      // page must SAY so.
      await page.goto(`/orders/${order.id}`);
      await expect(cancelledBanner).toBeVisible({ timeout: 15_000 });
      await expect(editItemsButton).toHaveCount(0);
      // …and it must be the cancelled copy, not the dispatched string
      // relabelled onto every closed window.
      await expect(page.getByText(DISPATCHED_BANNER, { exact: true })).toHaveCount(0);
    } finally {
      // Cleanup runs even when an assertion above fails, so a red run leaves no
      // cancelled order behind. A CANCELLED order with no invoices, payments or
      // returns is deletable by staff.
      await request
        .delete(`${api}/api/v1/orders/${order.id}`, { headers: headers! })
        .catch(() => undefined);
    }
  });
});
