/**
 * Batch ship + packing slips on the orders list (#3168).
 *
 * Role: OPERATOR on the approved e2e tenant. EVERY endpoint the flow touches is MOCKED (orders list,
 * /tenants/me/features, /orders/batch-ship, /orders/packing-slips), so nothing is written to any tenant
 * and no cleanup is needed. Asserts the browser side only: the bulk-bar action appears in select mode
 * (and only when the tenant's fulfilment methods include SHIP), the dialog rows, the request the UI
 * sends, the per-outcome results and the Print button for the shipped orders only. data-testid only for
 * the feature's own controls. Runs at 1440 / 768 / 390 with no horizontal overflow.
 *
 * Needs the "batch-ship" project in playwright.config.ts (no entry = the spec never runs).
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-tenant-slug",
};
function json(route: Route, body: unknown) {
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: CORS,
    body: JSON.stringify(body),
  });
}

const order = (id: string, n: number) => ({
  id,
  orderNumber: `E2E-SHIP-${n}`,
  status: "CONFIRMED",
  fulfillPath: "SHIP",
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  createdAt: "2026-10-01T00:00:00.000Z",
  requestedDeliveryDate: null,
  customer: { id: `c${n}`, businessName: `Acme Test ${n}` },
  lineItems: [],
});
const ORDERS = [order("e2e-bs-1", 1), order("e2e-bs-2", 2), order("e2e-bs-3", 3)];

async function mock(page: Page, methods: string[]) {
  const sent: { ship?: unknown; slips?: unknown } = {};
  await page.route(/\/api\/v1\/tenants\/me\/features/, (route) =>
    json(route, { capabilities: { fulfilment: { methods } } }),
  );
  await page.route(/\/api\/v1\/orders(\?.*)?$/, (route) =>
    route.request().method() === "GET"
      ? json(route, {
          data: ORDERS,
          meta: { total: ORDERS.length, page: 1, limit: 25, totalPages: 1 },
        })
      : route.continue(),
  );
  await page.route(/\/api\/v1\/orders\/batch-ship$/, (route) => {
    if (route.request().method() === "POST") sent.ship = route.request().postDataJSON();
    return json(route, {
      results: [
        { orderId: "e2e-bs-1", orderNumber: "E2E-SHIP-1", outcome: "SHIPPED", message: "" },
        { orderId: "e2e-bs-2", orderNumber: "E2E-SHIP-2", outcome: "CREDIT_HOLD", message: "" },
        { orderId: "e2e-bs-3", orderNumber: "E2E-SHIP-3", outcome: "ALREADY_SHIPPED", message: "" },
      ],
    });
  });
  await page.route(/\/api\/v1\/orders\/packing-slips$/, (route) => {
    if (route.request().method() === "POST") sent.slips = route.request().postDataJSON();
    return json(route, { url: null, included: [], skipped: [] });
  });
  return sent;
}

async function selectAll(page: Page) {
  await page.goto("/orders");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByText("Select all").first().click();
}

for (const vp of [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
]) {
  test.describe(`Batch ship @${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    test.beforeEach(async ({ context }) => {
      await setTenantCookie(context, BASE);
    });

    test("not offered when the tenant's fulfilment methods exclude SHIP", async ({ page }) => {
      await mock(page, ["ROUTE"]);
      await selectAll(page);
      await expect(page.getByTestId("batch-ship-open")).toHaveCount(0);
    });

    test("mark shipped: rows, request, per-outcome results, print only for shipped", async ({
      page,
    }) => {
      const sent = await mock(page, ["ROUTE", "SHIP"]);
      await selectAll(page);
      await page.getByTestId("batch-ship-open").click();
      await expect(page.getByTestId("batch-ship-dialog")).toBeVisible();
      for (const o of ORDERS)
        await expect(page.getByTestId(`batch-ship-row-${o.id}`)).toBeVisible();

      await page.getByTestId("batch-ship-tracking-e2e-bs-1").fill("E2E-TRACK-1");
      await page.getByTestId("batch-ship-submit").click();

      await expect(page.getByTestId("batch-ship-result-e2e-bs-2")).toHaveAttribute(
        "data-outcome",
        "CREDIT_HOLD",
      );
      await expect(page.getByTestId("batch-ship-result-e2e-bs-3")).toHaveAttribute(
        "data-outcome",
        "ALREADY_SHIPPED",
      );
      expect(sent.ship).toMatchObject({
        orders: [
          { orderId: "e2e-bs-1", trackingNumber: "E2E-TRACK-1" },
          { orderId: "e2e-bs-2" },
          { orderId: "e2e-bs-3" },
        ],
      });

      await page.getByTestId("batch-ship-print-slips").click();
      await expect.poll(() => sent.slips).toEqual({ orderIds: ["e2e-bs-1"] });

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(vp.width);
    });
  });
}
