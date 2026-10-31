/**
 * R-1 (one-step return capture, 1440/768/390) and R7b Batch 3 (mocked reads, nothing written): New Return by order number (B1264, 1280), the unit price's unit on the
 * order page (B1261, 390). Role: OPERATOR (pre-authed storage state). Registered as the "counter-return" project.
 */
import { test, expect, type Page } from "@playwright/test";
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

/** Wide screens show Record return in the action bar; at phone width it sits in the "More actions" menu (apple-ux r4). */
async function openRecordReturn(page: Page) {
  const more = page.getByRole("button", { name: "More actions" });
  if (await more.isVisible()) {
    await more.click();
    await page.getByRole("menuitem", { name: /record return|return items/i }).click();
    return;
  }
  await page.getByRole("button", { name: /record return|return items/i }).click();
}

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
  await openRecordReturn(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Cola 12oz Can");
  await dialog.getByLabel(/^pieces$/i).fill("1");
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(dialog).toContainText("Removed Cola 12oz Can");
  await dialog.getByRole("button", { name: "Undo" }).click();
  await expect(dialog).toContainText("Cola 12oz Can");
  await expect(dialog.getByLabel(/^pieces$/i)).toHaveValue("1");
});

const QUOTE_ONE = {
  chunks: [
    {
      sourceOrderId: "e2e-r1",
      sourceInvoiceItemId: "inv-1",
      sourceOrderItemId: "l1",
      productId: "p1",
      pieces: 1,
      subtotal: 1.5,
      taxAmount: 0,
      categoryTax: 0,
      priceSource: "SOURCE_INVOICE",
      unitPrice: 1.5,
    },
  ],
  subtotal: 1.5,
  taxAmount: 0,
  categoryTax: 0,
  total: 1.5,
  productBreakdown: {},
  canRefund: true,
  paidInFull: true,
  paidMethods: ["CASH"],
  paidWithStoreCredit: false,
  customerIsWalkIn: true,
};

test("R-1: the optional line fields sit in a collapsed options row; the pieces field stays in view (390)", async ({
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
  await openRecordReturn(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel(/^pieces$/i)).toBeVisible();
  // collapsed: the panel stays mounted but hidden
  await expect(dialog.getByLabel(/note \(optional\)/i)).toBeHidden();
  const options = dialog.getByRole("button", { name: /options for cola 12oz can/i });
  await expect(options).toHaveAttribute("aria-expanded", "false");
  await options.click();
  await expect(options).toHaveAttribute("aria-expanded", "true");
  await dialog.getByLabel(/note \(optional\)/i).fill("Dented can");
  // a note keeps its line open and its value, even across Remove and Undo
  await dialog.getByLabel(/^pieces$/i).fill("1");
  await dialog.getByRole("button", { name: "Remove" }).click();
  await dialog.getByRole("button", { name: "Undo" }).click();
  await expect(options).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByLabel(/note \(optional\)/i)).toHaveValue("Dented can");
  await page.screenshot({ path: "test-results/r1-returns-options-390.png" });
});

for (const width of [1440, 768, 390]) {
  test(`R-1: one list, the credit follows the quantity by itself, and another product can still be added (${width})`, async ({
    page,
    context,
    baseURL,
  }) => {
    await setTenantCookie(context, baseURL ?? "");
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.route(/\/api\/v1\/tenants\/me\/addons/, (r) =>
      r.fulfill({ json: { addons: ["orders_inline_returns"] } }),
    );
    await page.route(/\/api\/v1\/orders\/e2e-r1$/, (r) => r.fulfill({ json: WALKIN_ORDER }));
    await page.route(/\/api\/v1\/products\?/, (r) =>
      r.fulfill({
        json: {
          data: [{ id: "p2", name: "Chips Large", unit: "each", unitsPerBox: null }],
          meta: { total: 1, page: 1, limit: 10, totalPages: 1 },
        },
      }),
    );
    let quotes = 0;
    await page.route(/\/api\/v1\/returns\/inline\/quote$/, (r) => {
      quotes += 1;
      return r.fulfill({ json: QUOTE_ONE });
    });
    await page.goto("/orders/e2e-r1");
    await openRecordReturn(page);
    const dialog = page.getByRole("dialog");
    // one render: no Get quote and no Back, from the first screen
    await expect(dialog.getByRole("button", { name: /get quote/i })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /^back$/i })).toHaveCount(0);
    await expect(dialog.getByLabel(/reason for all items/i)).toHaveValue("EXCESS_ORDER");
    await dialog.getByLabel(/^pieces$/i).fill("1");
    // the credit is worked out on its own, and the line says what it will do
    await expect(dialog.getByTestId("return-summary")).toContainText("Total");
    await expect(dialog.getByTestId("return-summary")).toContainText("$1.50");
    await expect(dialog.getByTestId("return-line-summary-p1")).toContainText(
      /Credit \$1\.50 · .+ · Back to stock/,
    );
    expect(quotes).toBeGreaterThan(0);
    // the add box is still there after pricing: a second product joins at 1 piece, Qty selected
    await dialog.getByLabel(/add another product/i).fill("Chips");
    await dialog.getByRole("button", { name: "Chips Large" }).click();
    const second = dialog.getByTestId("return-line-p2");
    await expect(second).toBeVisible();
    await expect(second.getByLabel(/^pieces$/i)).toHaveValue("1");
    await expect(second.getByLabel(/^pieces$/i)).toBeFocused();
    // nothing runs off the side of the screen
    const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/r1-returns-one-step-${width}.png` });
  });
}

test("R-1 + W-712 F25: the confirm button carries the real amount and the walk-in refund sentence (390)", async ({
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
  await page.route(/\/api\/v1\/returns\/inline\/quote$/, (r) => r.fulfill({ json: QUOTE_ONE }));
  await page.goto("/orders/e2e-r1");
  await openRecordReturn(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^pieces$/i).fill("1");
  // the order the goods came from is in the line's options, titled by the product
  await dialog.getByRole("button", { name: /options for cola 12oz can/i }).click();
  await expect(dialog.getByText(/From order #ORD-00001/)).toBeVisible();
  // walk-in sales refund: ONE sentence says why (mm-ux judge, notes/apple-ux/2026-10-25-w783-judge-3748.md: no second
  // "goes back" line) and the button carries the real amount
  await expect(dialog).toContainText("Walk-in sales can't hold store credit, so refund the money.");
  await expect(dialog).not.toContainText(/goes back to the customer/i);
  await expect(
    dialog.getByRole("button", { name: "Take back items and refund $1.50" }),
  ).toBeVisible();
  await expect(dialog).not.toContainText(/credit note/i);
  await page.screenshot({ path: "test-results/r1-returns-quote-390.png" });
});
