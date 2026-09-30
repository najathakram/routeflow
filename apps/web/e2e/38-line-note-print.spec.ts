/**
 * WP4 — web print surfaces (T12, R6.6 / R6.10).
 *
 * FULLY MOCKED — NO WRITES: `GET /invoices` (list), `GET /invoices/kpi-summary`,
 * `GET /invoices/:id/pdf`, and the PDF-bytes URL are all intercepted with
 * `page.route` before the page is opened — same technique as
 * `28-credit-note-wallet.spec.ts`. No seeded invoices (L-060/062/129
 * pattern). Nothing is created or mutated on any tenant.
 *
 * Role: OPERATOR (storage state from the "line-note-print" project, cloned
 * from "calendar-dates" — see playwright.config.ts).
 *
 * Flow A: clicking the row's Print button must not trigger the row's own
 * navigate-to-detail click handler (ux-spec "Playwright flows" #1).
 * Flow B: `@media print` must hide the dashboard chrome (`aside`, `header`)
 * on the invoices list (ux-spec "Playwright flows" #3).
 */
import { test, expect, type Page, type Route } from "@playwright/test";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-tenant-slug",
};

function fulfillJson(route: Route, body: unknown, status = 200) {
  if (route.request().method() === "OPTIONS") {
    return route.fulfill({ status: 204, headers: CORS_HEADERS });
  }
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  });
}

const INVOICE_ID = "e2e-inv-38-0001";
const INVOICE_NUMBER = "INV-E2E-1";

function invoiceFixture() {
  return {
    id: INVOICE_ID,
    invoiceNumber: INVOICE_NUMBER,
    customer: { id: "e2e-cust-38-0001", businessName: "E2E Print Co" },
    status: "SENT",
    issueDate: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    dueDate: "2026-01-15T00:00:00.000Z",
    total: 100,
    paidAmount: 0,
    balanceDue: 100,
  };
}

async function mockInvoicesList(page: Page) {
  await page.route(/\/api\/v1\/invoices(\?.*)?$/, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return fulfillJson(route, {
      data: [invoiceFixture()],
      meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
    });
  });
  await page.route(/\/api\/v1\/invoices\/kpi-summary(\?.*)?$/, (route) =>
    fulfillJson(route, {
      totalOutstanding: 100,
      dueToday: 0,
      dueIn30: 100,
      overdue: 0,
      avgDays: 0,
      awaitingConfirmationCount: 0,
    }),
  );
}

async function mockInvoicePdf(page: Page) {
  await page.route(new RegExp(`/api/v1/invoices/${INVOICE_ID}/pdf(\\?.*)?$`), (route) =>
    fulfillJson(route, { url: `${new URL(route.request().url()).origin}/e2e.pdf` }),
  );
  await page.route(/\/e2e\.pdf$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/pdf",
      headers: CORS_HEADERS,
      body: Buffer.from("%PDF-1.4"),
    }),
  );
}

test.describe("Web print surfaces (WP4)", () => {
  test("Flow A: clicking a row's Print button does not navigate away from /invoices (R6.6)", async ({
    page,
  }) => {
    await mockInvoicesList(page);
    await mockInvoicePdf(page);

    await page.goto("/invoices");

    const printButton = page.getByRole("button", { name: `Print invoice ${INVOICE_NUMBER}` });
    await expect(printButton).toBeVisible({ timeout: 15_000 });
    await printButton.click();

    // The mocked /pdf response has resolved by the time the button's own
    // mutation settles — assert the page never left the list (the row's
    // click-to-navigate handler must not have fired).
    await expect(page).toHaveURL(/\/invoices$/);
  });

  test("Flow B: @media print hides the dashboard chrome on /invoices (R6.10)", async ({ page }) => {
    await mockInvoicesList(page);

    await page.goto("/invoices");
    await expect(page.locator("#main-content")).toBeVisible({ timeout: 15_000 });

    await page.emulateMedia({ media: "print" });

    await expect(page.locator("aside")).toBeHidden();
    await expect(page.locator("header")).toBeHidden();
  });
});
