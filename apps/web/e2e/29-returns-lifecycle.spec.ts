/**
 * F08 — returns lifecycle on the operator web UI (T12 / T13 / T14, T2 rows,
 * bug-test-plan.md).
 *
 * REG-B166 — the returns list search box does not filter: it renders every
 * return on the tenant regardless of what is typed into "Return #, order # or
 * customer…". REG-B75 — the list's Value column (and the KPI "Total Return
 * Value" card) computes from `item.unitPrice`, a field the return-item payload
 * never carries, so every row and the KPI both read $0.00 no matter what the
 * order actually billed. REG-B21 — the return detail page renders no cancel
 * control at all for a PENDING return (no `canCancel` wiring), and the
 * server-side `create()` over-return guard still counts CANCELLED returns
 * against the ordered quantity, so a corrected mistake permanently eats the
 * customer's return quota (B82, proven server-side in returns-overreturn.spec.ts
 * T4 — this spec is the UI leg that a cancelled-and-recreated return actually
 * succeeds end to end).
 *
 * T2, proven-pending-deploy (bug-test-plan.md): these run against the DEPLOYED
 * site, never locally in this pipeline, and are deliberately NOT part of the
 * jest red gate (no local Playwright — package brief). They ARE expected red
 * against a pre-F08 build: the search box returns every row regardless of
 * input, the Value/KPI cells read $0.00 no matter what was billed, and no
 * "Cancel Return" control exists to even attempt the click.
 *
 * Role: OPERATOR (reads its token out of the pre-authenticated session, same
 * convention as 21-destructive-guards / 22-payment-truth / 27). Tenant: the
 * approved e2e-routeflow regression seed — never a live client (enforced by
 * helpers/constants.ts's assertTestTenant at import time).
 *
 * Every fixture is self-provisioned and named `E2E B### …`: a throwaway
 * product + customer + order per test, taken PENDING → CONFIRMED → DELIVERED
 * (the auto-invoice fires synchronously on that last transition — F08's B53
 * billed-basis fix and this spec's $10.00 both depend on that invoice
 * existing before the return is created). Nothing is deleted afterward: a
 * DELIVERED order with an invoice and a return against it is not staff-deletable
 * anyway, and this is the same residue tolerance 21/22/24/27 already take.
 */

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

type Headers = { authorization: string; "x-tenant-slug": string };

/** Bearer + tenant headers for a direct API call, or null when unauthenticated. */
async function apiHeaders(page: Page): Promise<Headers | null> {
  const token = await operatorAccessToken(page);
  if (!token) return null;
  return { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
}

/**
 * Builds one throwaway DELIVERED order for `qty` units of a fresh $5.00/unit
 * product, and returns the ids the caller needs to create a return against it.
 * The PENDING → CONFIRMED → DELIVERED walk (not a direct create-as-DELIVERED)
 * is required: DELIVERED is not a legal `create()` status and the auto-invoice
 * only fires on the manual status-change path (orders.service.ts ~:2643).
 */
async function buildDeliveredOrder(
  request: APIRequestContext,
  api: string,
  headers: Headers,
  suffix: string,
  qty: number,
): Promise<{ orderId: string; productId: string; customerId: string }> {
  const productRes = await request.post(`${api}/api/v1/products`, {
    headers,
    data: { name: `E2E B08 Widget ${suffix}`, unit: "unit", pricePerUnit: "5.00" },
  });
  expect(productRes.ok(), `POST /products returned ${productRes.status()}`).toBe(true);
  const product: { id: string } = await productRes.json();
  expect(product?.id, "POST /products response carried no id").toBeTruthy();

  const customerRes = await request.post(`${api}/api/v1/customers`, {
    headers,
    data: {
      username: `e2e_b08_${suffix}`,
      businessName: `E2E B08 Returns ${suffix}`,
      contactName: "E2E Tester",
    },
  });
  expect(customerRes.ok(), `POST /customers returned ${customerRes.status()}`).toBe(true);
  const customer: { id: string } = (await customerRes.json()).customer;
  expect(customer?.id, "POST /customers response carried no customer.id").toBeTruthy();

  const orderRes = await request.post(`${api}/api/v1/orders`, {
    headers,
    data: {
      customerId: customer.id,
      status: "PENDING",
      mergeChoice: "separate",
      items: [{ productId: product.id, qty }],
    },
  });
  expect(orderRes.ok(), `POST /orders returned ${orderRes.status()}`).toBe(true);
  const order: { id: string } = await orderRes.json();
  expect(order?.id, "POST /orders response carried no id").toBeTruthy();

  const confirmRes = await request.patch(`${api}/api/v1/orders/${order.id}/status`, {
    headers,
    data: { status: "CONFIRMED" },
  });
  expect(
    confirmRes.ok(),
    `PATCH /orders/:id/status (CONFIRMED) returned ${confirmRes.status()}`,
  ).toBe(true);

  const deliverRes = await request.patch(`${api}/api/v1/orders/${order.id}/status`, {
    headers,
    data: { status: "DELIVERED" },
  });
  expect(
    deliverRes.ok(),
    `PATCH /orders/:id/status (DELIVERED) returned ${deliverRes.status()}`,
  ).toBe(true);

  return { orderId: order.id, productId: product.id, customerId: customer.id };
}

test.describe("Returns lifecycle (F08)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  test("REG-B166 the returns search box narrows the list to the typed return, order, or customer (T12)", async ({
    page,
    request,
  }) => {
    await page.goto("/returns");
    await expect(page.getByRole("button", { name: "New Return" })).toBeVisible({
      timeout: 15_000,
    });

    const headers = await apiHeaders(page);
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());
    const suffix = `${Date.now()}`;

    const { orderId, productId } = await buildDeliveredOrder(request, api, headers!, suffix, 1);

    const returnRes = await request.post(`${api}/api/v1/returns`, {
      headers: headers!,
      data: {
        orderId,
        reason: "DAMAGED",
        items: [{ productId, qty: 1 }],
      },
    });
    expect(returnRes.ok(), `POST /returns returned ${returnRes.status()}`).toBe(true);
    const ret: { id: string; returnNumber: string } = await returnRes.json();
    expect(ret?.returnNumber, "POST /returns response carried no returnNumber").toBeTruthy();

    const searchBox = page.getByPlaceholder("Return #, order # or customer…");
    const returnRow = page.locator("tbody tr", { hasText: ret.returnNumber });

    // ── The positive case: searching the fixture's own return number narrows
    // the table to EXACTLY that row. A search box that is unwired (B166) leaves
    // every other return on the tenant in the table too, so this fails on the
    // row COUNT rather than merely on the fixture row's own visibility.
    await page.goto("/returns");
    await expect(page.getByRole("button", { name: "New Return" })).toBeVisible({
      timeout: 15_000,
    });
    await searchBox.fill(ret.returnNumber);
    await expect(returnRow).toBeVisible({ timeout: 15_000 });
    // First cell of the (only) visible row is the return number itself.
    await expect(page.locator("tbody tr").first().locator("td").first()).toHaveText(
      ret.returnNumber,
    );
    await expect(page.locator("tbody tr")).toHaveCount(1, { timeout: 15_000 });

    // ── The negative case: a nonsense string matches nothing on this tenant,
    // so the table must render its "no returns match" empty state rather than
    // the unfiltered list an unwired search box would still show.
    await searchBox.fill(`nonexistent-return-${suffix}-zzz`);
    await expect(page.getByText("No returns match your filters.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator("tbody tr")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator("tbody tr").first()).not.toContainText(ret.returnNumber);
  });

  test("REG-B75 the returns list and KPI show the billed return value, not $0.00 (T13)", async ({
    page,
    request,
  }) => {
    await page.goto("/returns");
    await expect(page.getByRole("button", { name: "New Return" })).toBeVisible({
      timeout: 15_000,
    });

    const headers = await apiHeaders(page);
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());
    const suffix = `${Date.now()}`;

    // ── Baseline for the KPI's delta half, read BEFORE this run's fixture
    // exists — the tile sums return value across the WHOLE tenant and this
    // spec leaves its fixture behind (residue tolerance, same as 22/23/27), so
    // only the movement THIS fixture causes can discriminate a fix from B75.
    const kpiValue = page
      .locator("text=Total Return Value")
      .locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]")
      .getByText(/^\$[\d,.]+$/);
    await expect(kpiValue).toBeVisible({ timeout: 15_000 });
    const beforeText = (await kpiValue.textContent()) ?? "$0";
    const before = Number(beforeText.replace(/[^0-9.]/g, ""));

    // ── The tile only ever sums the NEWEST 500 returns (page.tsx's summary
    // query is `useReturns({ limit: 500 })`, and findAll orders `createdAt
    // desc` with `take: limit`). Since this spec leaves its fixtures behind,
    // once the regression tenant holds 500+ returns this run's fixture evicts
    // an older one and the delta stops being exactly $10.00. Read the tenant's
    // return count up front and downgrade only the delta leg when that day
    // comes — the row's billed-basis $10.00 below stays the primary oracle.
    const countRes = await request.get(`${api}/api/v1/returns?limit=1`, { headers: headers! });
    expect(countRes.ok(), `GET /returns?limit=1 returned ${countRes.status()}`).toBe(true);
    const countBody: { meta?: { total?: number } } = await countRes.json();
    const kpiWindowSaturated = (countBody.meta?.total ?? 0) + 3 > 500;

    // 2 units × $5.00/unit billed = a $10.00 return: not a round number that
    // could collide with an order count, a qty, or any other figure the page
    // renders, and distinct from every other fixture's own value.
    const { orderId, productId } = await buildDeliveredOrder(request, api, headers!, suffix, 2);

    const returnRes = await request.post(`${api}/api/v1/returns`, {
      headers: headers!,
      data: {
        orderId,
        reason: "DAMAGED",
        items: [{ productId, qty: 2 }],
      },
    });
    expect(returnRes.ok(), `POST /returns returned ${returnRes.status()}`).toBe(true);
    const ret: { id: string; returnNumber: string } = await returnRes.json();
    expect(ret?.returnNumber, "POST /returns response carried no returnNumber").toBeTruthy();

    await page.goto("/returns");
    await expect(page.getByRole("button", { name: "New Return" })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByPlaceholder("Return #, order # or customer…").fill(ret.returnNumber);
    const returnRow = page.locator("tbody tr", { hasText: ret.returnNumber });
    await expect(returnRow).toBeVisible({ timeout: 15_000 });

    // The row's Value column (7th of 9 columns: #, Customer, Order, Reason,
    // Date, Items, Value, Status, actions) must read the billed $10.00, not
    // the $0.00 an unset `item.unitPrice` produces today.
    await expect(returnRow.locator("td").nth(6)).toHaveText("$10.00", { timeout: 15_000 });

    // The KPI tile must have grown by EXACTLY this fixture's $10.00 — proven
    // against the pre-fixture baseline read above, never a bare non-zero check
    // a stale cached $0.00-plus-something could also satisfy. Only once the
    // 500-row KPI window is saturated (eviction makes the exact delta
    // unknowable) does this fall back to "the tile is at least this fixture's
    // $10.00", which still reads red on B75's all-$0.00 sum.
    await page.goto("/returns");
    await expect(kpiValue).toBeVisible({ timeout: 15_000 });
    const readKpi = async () => {
      const text = (await kpiValue.textContent()) ?? "$0";
      return Number(text.replace(/[^0-9.]/g, ""));
    };
    if (kpiWindowSaturated) {
      test.info().annotations.push({
        type: "warning",
        description: "KPI window (newest 500) saturated — delta leg downgraded",
      });
      await expect.poll(readKpi, { timeout: 15_000 }).toBeGreaterThanOrEqual(10);
    } else {
      await expect.poll(readKpi, { timeout: 15_000 }).toBeCloseTo(before + 10, 2);
    }
  });

  test("REG-B21 a PENDING return can be cancelled from the detail page, and B82's quota is released for a second return on the same order (T14)", async ({
    page,
    request,
  }) => {
    await page.goto("/returns");
    await expect(page.getByRole("button", { name: "New Return" })).toBeVisible({
      timeout: 15_000,
    });

    const headers = await apiHeaders(page);
    expect(
      headers,
      "no operator access token in localStorage — operator storageState is stale or the setup project did not run",
    ).toBeTruthy();
    const api = apiBase(page.url());
    const suffix = `${Date.now()}`;

    const { orderId, productId } = await buildDeliveredOrder(request, api, headers!, suffix, 1);

    const returnRes = await request.post(`${api}/api/v1/returns`, {
      headers: headers!,
      data: {
        orderId,
        reason: "DAMAGED",
        items: [{ productId, qty: 1 }],
      },
    });
    expect(returnRes.ok(), `POST /returns returned ${returnRes.status()}`).toBe(true);
    const ret: { id: string; returnNumber: string; status: string } = await returnRes.json();
    expect(ret?.id, "POST /returns response carried no id").toBeTruthy();
    expect(ret.status, "fixture return must start PENDING").toBe("PENDING");

    // ── The control: the detail page for a PENDING return must offer a way to
    // cancel it. Absent today (B21 — no `canCancel` wiring), so this fails on
    // the button never appearing rather than on anything downstream of it.
    await page.goto(`/returns/${ret.id}`);
    await expect(page.getByRole("heading", { name: ret.returnNumber })).toBeVisible({
      timeout: 15_000,
    });
    const cancelButton = page.getByRole("button", { name: "Cancel Return", exact: true });
    await expect(cancelButton).toBeVisible({ timeout: 15_000 });
    await cancelButton.click();

    const confirmDialog = page.getByRole("dialog");
    await expect(confirmDialog).toBeVisible({ timeout: 10_000 });
    await confirmDialog.getByRole("button", { name: "Cancel Return", exact: true }).click();
    await expect(confirmDialog).toHaveCount(0, { timeout: 10_000 });

    // The status badge on the same page must now read Cancelled.
    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 15_000 });

    // The server agrees — the UI click actually reached POST /returns/:id/cancel,
    // not just a locally-flipped badge.
    const getRes = await request.get(`${api}/api/v1/returns/${ret.id}`, { headers: headers! });
    expect(getRes.ok(), `GET /returns/:id returned ${getRes.status()}`).toBe(true);
    const cancelled: { status: string } = await getRes.json();
    expect(cancelled.status, "server-side status after the UI cancel").toBe("CANCELLED");

    // ── B82: a return that was created-then-cancelled must NOT still count
    // against the order's returnable quantity. A second return for the SAME
    // product/qty on the SAME order must succeed — it fails today with the
    // over-return guard's `status: { not: 'REJECTED' }` clause still counting
    // this CANCELLED row.
    const secondReturnRes = await request.post(`${api}/api/v1/returns`, {
      headers: headers!,
      data: {
        orderId,
        reason: "DAMAGED",
        items: [{ productId, qty: 1 }],
      },
    });
    expect(
      secondReturnRes.ok(),
      `POST /returns (2nd, same order, B82 check) returned ${secondReturnRes.status()}: ${await secondReturnRes.text()}`,
    ).toBe(true);
    const secondReturn: { id: string; status: string } = await secondReturnRes.json();
    expect(secondReturn.id).not.toBe(ret.id);
    expect(secondReturn.status).toBe("PENDING");
  });
});
