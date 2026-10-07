/**
 * POS-7b-2: the counter's "Today's sales" sheet at 1440 / 768 / 390, plus the 80 mm reprint under print media.
 * Read-only: GET /orders/counter-sale/today (POS-7b-1) and GET /orders/:id are mocked, so nothing is written to the tenant.
 * Role: OPERATOR (pre-authed storage state). Registered as the "counter-todays-sales" project in playwright.config.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";

const ROW = {
  orderId: "e2e-o1",
  invoiceId: "e2e-i1",
  orderNumber: "ORD-E2E-1",
  invoiceNumber: "INV-E2E-1",
  createdAt: "2026-10-07T15:15:00.000Z",
  total: 22.5,
  customerId: "c1",
  customerName: null,
  isWalkIn: true,
  status: "DELIVERED",
  paymentState: "PAID",
  methods: [{ method: "CASH", amount: 22.5 }],
  returned: { amount: 0, state: "NONE", returns: [] },
  voided: false,
};
const PAGE1 = {
  data: [ROW, { ...ROW, orderId: "e2e-o2", orderNumber: "ORD-E2E-2", voided: true }],
  meta: {
    total: 2,
    page: 1,
    limit: 25,
    totalPages: 1,
    day: "2026-10-07",
    timezone: "America/New_York",
    windowStart: "2026-10-07T04:00:00.000Z",
    windowEnd: "2026-10-08T04:00:00.000Z",
  },
  summary: {
    sales: { count: 2, total: 45 },
    moneyIn: { cash: 22.5, card: 0, check: 0, other: 0, total: 22.5 },
    storeCreditUsed: 0,
    onAccount: 0,
    refunds: { count: 0, cash: 0, card: 0, check: 0, other: 0, total: 0, tenderKnown: false },
    storeCreditIssued: { count: 0, amount: 0 },
    cashExpectedInDrawer: 22.5,
    netCollected: 22.5,
  },
};
const ORDER = {
  id: "e2e-o1",
  orderNumber: "ORD-E2E-1",
  customerId: "c1",
  total: 22.5,
  status: "DELIVERED",
  lineItems: [{ id: "l1", name: "Cola", qty: 9, unitPrice: 2.5 }],
};

async function mock(page: Page) {
  await page.route(/\/api\/v1\/orders\/counter-sale\/today/, (r) => r.fulfill({ json: PAGE1 }));
  await page.route(/\/api\/v1\/orders\/e2e-o1$/, (r) => r.fulfill({ json: ORDER }));
}
async function openSheet(page: Page) {
  await mock(page);
  await page.goto("/orders/counter-sale");
  await page.getByRole("button", { name: "Today's sales" }).click();
  await expect(page.getByTestId("today-summary")).toBeVisible();
}

for (const [name, width, height] of [
  ["desktop", 1440, 900],
  ["tablet", 768, 1024],
  ["phone", 390, 844],
] as const) {
  test(`Today's sales sheet fits and has 44 px actions at ${name} (${width})`, async ({
    page,
    context,
    baseURL,
  }) => {
    await setTenantCookie(context, baseURL ?? "");
    await page.setViewportSize({ width, height });
    await openSheet(page);
    const noOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(noOverflow).toBe(true);
    const row = page.getByTestId("today-row-e2e-o1");
    for (const name of ["Reprint"]) {
      const box = await row.getByRole("button", { name }).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    const link = await row.getByRole("link", { name: "View order" }).boundingBox();
    expect(link?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect(page.getByTestId("today-row-e2e-o2").getByText("Voided")).toBeVisible();
  });
}

test("reprint prints on 80 mm paper with no Tendered or Change", async ({
  page,
  context,
  baseURL,
}) => {
  await setTenantCookie(context, baseURL ?? "");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSheet(page);
  await page.getByTestId("today-row-e2e-o1").getByRole("button", { name: "Reprint" }).click();
  const root = page.getByTestId("receipt-print-root");
  await expect(root.getByTestId("receipt-reprint")).toContainText("Reprint · sold");
  await expect(root).not.toContainText(/Tendered|Change/);
  await page.emulateMedia({ media: "print" });
  const pageRule = await page.evaluate(() =>
    Array.from(document.styleSheets).length >= 0
      ? Array.from(document.querySelectorAll("style")).some((s) =>
          /@page\s*{\s*size:\s*80mm auto/.test(s.textContent ?? ""),
        )
      : false,
  );
  expect(pageRule).toBe(true);
  await expect(page.getByRole("button", { name: "Print" })).toBeHidden();
  await expect(root).toBeVisible();
});
