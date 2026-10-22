/**
 * R7b Batch 3 (mocked reads, nothing written): New Return by order number (B1264, 1280), the unit price's unit on the
 * order page (B1261, 390). Role: OPERATOR (pre-authed storage state). Registered as the "counter-return" project.
 */
import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";

const WALKIN_ORDER = {
  id: "e2e-r1",
  orderNumber: "ORD-00001",
  customerId: "e2e-walk",
  customer: { id: "e2e-walk", businessName: "Walk-in", isWalkIn: true },
  status: "DELIVERED",
  total: 36,
  lineItems: [
    {
      id: "l1",
      productId: "p1",
      product: { id: "p1", name: "Cola 12oz Can", unit: "each", unitsPerBox: 24 },
      qty: 2,
      boxes: 0,
      pieces: 2,
      unitsPerBox: 24,
      unitPrice: 18,
      subtotal: 1.5,
      priceType: "STANDARD",
      status: "DELIVERED",
    },
  ],
};

test("B1264: New Return, type an order number, the return form for that order opens (1280)", async ({
  page,
  context,
  baseURL,
}) => {
  await setTenantCookie(context, baseURL ?? "");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route(/\/api\/v1\/tenants\/me\/addons/, (r) =>
    r.fulfill({ json: { addons: ["orders_inline_returns"] } }),
  );
  await page.route(/\/api\/v1\/orders\?.*search=ORD-00001/, (r) =>
    r.fulfill({
      json: { data: [WALKIN_ORDER], meta: { total: 1, page: 1, limit: 10, totalPages: 1 } },
    }),
  );
  await page.route(/\/api\/v1\/orders\/e2e-r1$/, (r) => r.fulfill({ json: WALKIN_ORDER }));
  await page.goto("/returns");
  await page.getByRole("button", { name: "New Return" }).click();
  await page.getByLabel("Find by order or invoice number").fill("ORD-00001");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByRole("dialog")).toContainText("Cola 12oz Can");
});

test("B1261: the order page's Unit Price cell names its unit and the price each (390)", async ({
  page,
  context,
  baseURL,
}) => {
  await setTenantCookie(context, baseURL ?? "");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/\/api\/v1\/orders\/e2e-r1$/, (r) => r.fulfill({ json: WALKIN_ORDER }));
  await page.goto("/orders/e2e-r1");
  const cell = page.getByTestId("line-unit-price-unit").first();
  await expect(cell).toContainText("/ box");
  await expect(cell).toContainText("each");
});

test("R7b 3.1: Remove then Undo brings the return line back (390)", async ({
  page,
  context,
  baseURL,
}) => {
  await setTenantCookie(context, baseURL ?? "");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/\/api\/v1\/tenants\/me\/addons/, (r) =>
    r.fulfill({ json: { addons: ["orders_inline_returns"] } }),
  );
  await page.route(/\/api\/v1\/orders\/e2e-r1$/, (r) => r.fulfill({ json: WALKIN_ORDER }));
  await page.goto("/orders/e2e-r1");
  await page.getByRole("button", { name: /record return|return items/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Cola 12oz Can");
  await dialog.getByLabel(/^pieces$/i).fill("1");
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(dialog).toContainText("Removed Cola 12oz Can");
  await dialog.getByRole("button", { name: "Undo" }).click();
  await expect(dialog).toContainText("Cola 12oz Can");
  await expect(dialog.getByLabel(/^pieces$/i)).toHaveValue("1");
});
