/**
 * POS-7b-2: the counter's "Today's sales" sheet at 1440 / 768 / 390, plus the 80 mm reprint under print media.
 * Read-only: GET /orders/counter-sale/today (POS-7b-1) and GET /orders/:id are mocked, so nothing is written to the tenant.
 * Role: OPERATOR (pre-authed storage state). Registered as the "counter-todays-sales" project in playwright.config.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { apiBase } from "./helpers/api";
import { isLocalOnlyLane } from "../lib/local-fulfilment-guard";
import {
  applyBusinessProfile,
  localTarget,
  restoreFulfilmentConfig,
  snapshotFulfilmentConfig,
  type FulfilmentSnapshot,
} from "./helpers/local-fulfilment-profile";

// Counter sales are opt-in per business and the e2e tenant has them off: on a local target, turn the counter on exactly as
// spec 72 does and put the tenant's config back row for row afterwards. Elsewhere (a deployed tenant) nothing is written.
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const LOCAL = isLocalOnlyLane(process.env);
let before: FulfilmentSnapshot | null = null;
const target = () => localTarget(apiBase(BASE));

test.beforeAll(async () => {
  if (!LOCAL) return;
  before = await snapshotFulfilmentConfig(target());
  await applyBusinessProfile(target(), before, "in_store_shipping_retailer");
});

test.afterAll(async () => {
  if (!LOCAL || !before) return;
  test.setTimeout(120_000);
  const restored = await restoreFulfilmentConfig(target(), before);
  expect(restored, "the tenant's fulfilment config is back exactly as it was").toBe(true);
});

const ROW = {
  orderId: "e2e-o1",
  invoiceId: "e2e-i1",
  orderNumber: "ORD-E2E-1",
  invoiceNumber: "INV-E2E-1",
  createdAt: "2026-10-07T15:15:00.000Z",
  total: 22.5,
  paid: 22.5,
  balanceDue: 0,
  customerId: "c1",
  customerName: null,
  isWalkIn: true,
  status: "DELIVERED",
  paymentState: "PAID",
  methods: [{ method: "CASH", amount: 22.5 }],
  items: [
    { name: "Cola 12oz Can", qty: 2 },
    { name: "Ice Bag 10lb", qty: 1 },
    { name: "Chips", qty: 1 },
  ],
  itemCount: 3,
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
  // measure after the sheet's open animation settles (a mid-scale box reads < 44 px)
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
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
    // R7b 2.1: the row names what was sold, on one line, with no horizontal overflow (checked above)
    await expect(row.getByTestId("today-row-items")).toHaveText(
      "Cola 12oz Can ×2, Ice Bag 10lb +1 more",
    );
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
  await expect(root.getByTestId("receipt-reprint")).toContainText("Reprint · Sold");
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
  // only the receipt prints: the sale screen behind the modal (scan field, cart) and the title are hidden
  await expect(page.getByLabel("Scan or search items")).toBeHidden();
  await expect(page.getByTestId("counter-sale-screen")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Reprint receipt" })).toBeHidden();
  await expect(page.getByTestId("counter-cart-column")).toBeHidden();
  await expect(page.getByTestId("counter-payment-column")).toBeHidden();
  await expect(page.getByRole("button", { name: /^Complete/ })).toHaveCount(0);
  await expect(root).toBeVisible();
});

test("R7b 2.2: the Void dialog title names the sale total", async ({ page, context, baseURL }) => {
  await setTenantCookie(context, baseURL ?? "");
  await page.setViewportSize({ width: 768, height: 1024 });
  await openSheet(page);
  await page
    .getByTestId("today-row-e2e-o1")
    .getByRole("button", { name: /^Void sale/ })
    .click();
  await expect(page.getByRole("dialog", { name: /Void sale/ })).toContainText("$");
});

test("R7b 2.4: on a day with 7 sales the first sale row is visible without scrolling at 390", async ({
  page,
  context,
  baseURL,
}) => {
  await setTenantCookie(context, baseURL ?? "");
  await page.setViewportSize({ width: 390, height: 844 });
  const rows = Array.from({ length: 7 }, (_, i) => ({
    ...ROW,
    orderId: `e2e-d${i + 1}`,
    orderNumber: `ORD-E2E-D${i + 1}`,
    voided: false,
  }));
  await page.route(/\/api\/v1\/orders\/counter-sale\/today/, (r) =>
    r.fulfill({
      json: {
        ...PAGE1,
        data: rows,
        meta: { ...PAGE1.meta, total: 7 },
        summary: { ...PAGE1.summary, sales: { count: 7, total: 157.5 } },
      },
    }),
  );
  await page.goto("/orders/counter-sale");
  await page.getByRole("button", { name: "Today's sales" }).click();
  await expect(page.getByTestId("today-summary")).toBeVisible();
  await expect(page.getByTestId("today-row-e2e-d1")).toBeInViewport();
  await expect(page.getByRole("button", { name: "Show all figures" })).toBeVisible();
});

test("R7b 3.3 (B1262): a reprint of a sale with a return says Returned at 390", async ({
  page,
  context,
  baseURL,
}) => {
  await setTenantCookie(context, baseURL ?? "");
  await page.setViewportSize({ width: 390, height: 844 });
  // an on-account sale whose only credit is its own return (SA-838): the credit is in `paid`, not in the tender split
  const returnedRow = {
    ...ROW,
    paid: 6.25,
    balanceDue: 16.25,
    methods: [{ method: "STORE_CREDIT", amount: 6.25 }],
    tenderPaid: 0,
    returnCredit: 6.25,
    tenderMethods: [],
    returnLines: { applied: 6.25, refunded: 0, kept: 0, used: 0, pending: false },
    returned: {
      amount: 6.25,
      state: "PARTLY",
      returns: [
        {
          id: "e2e-r1",
          returnNumber: "R-1",
          status: "PROCESSED",
          resolution: "STORE_CREDIT",
          amount: 6.25,
        },
      ],
    },
  };
  await page.route(/\/api\/v1\/orders\/counter-sale\/today/, (r) =>
    r.fulfill({ json: { ...PAGE1, data: [returnedRow], meta: { ...PAGE1.meta, total: 1 } } }),
  );
  await page.route(/\/api\/v1\/orders\/e2e-o1$/, (r) => r.fulfill({ json: ORDER }));
  await page.goto("/orders/counter-sale");
  await page.getByRole("button", { name: "Today's sales" }).click();
  await page.getByTestId("today-row-e2e-o1").getByRole("button", { name: "Reprint" }).click();
  await expect(page.getByTestId("receipt-reprint")).toBeVisible();
  await expect(page.getByTestId("receipt-returned")).toContainText("Returned");
  await expect(page.getByTestId("receipt-returned")).toContainText("6.25");
  await expect(page.getByTestId("counter-on-account")).toContainText("On account");
  await expect(page.getByTestId("receipt-reprint")).not.toContainText("Store credit");
});

test("SA-838a: a reprint with a pending, a refunded and a kept return prints the pinned lines at 390", async ({
  page,
  context,
  baseURL,
}) => {
  await setTenantCookie(context, baseURL ?? "");
  await page.setViewportSize({ width: 390, height: 844 });
  // Total $12.50, Cash $5.00: balance 7.50 and nothing subtracted for a refunded, kept or pending return
  const row = (lines: { refunded: number; kept: number; used?: number; pending: boolean }) => ({
    ...ROW,
    paid: 5,
    balanceDue: 7.5,
    methods: [{ method: "CASH", amount: 5 }],
    tenderPaid: 5,
    returnCredit: 0,
    tenderMethods: [{ method: "CASH", amount: 5 }],
    returnLines: { applied: 0, used: 0, ...lines },
  });
  for (const [lines, expected] of [
    [{ refunded: 2.5, kept: 0, pending: false }, "Refunded $2.50 (returned items)"],
    [{ refunded: 0, kept: 2.5, pending: false }, "Credit kept $2.50 (returned items)"],
    [{ refunded: 0, kept: 0, used: 2.5, pending: false }, "Credit used $2.50 (returned items)"],
    [{ refunded: 0, kept: 0, pending: true }, "Return in progress"],
  ] as const) {
    await page.route(/\/api\/v1\/orders\/counter-sale\/today/, (r) =>
      r.fulfill({ json: { ...PAGE1, data: [row(lines)], meta: { ...PAGE1.meta, total: 1 } } }),
    );
    await page.route(/\/api\/v1\/orders\/e2e-o1$/, (r) => r.fulfill({ json: ORDER }));
    await page.goto("/orders/counter-sale");
    await page.getByRole("button", { name: "Today's sales" }).click();
    await page.getByTestId("today-row-e2e-o1").getByRole("button", { name: "Reprint" }).click();
    const paper = page.getByTestId("receipt-reprint");
    await expect(paper).toContainText("Cash $5.00");
    await expect(paper).toContainText(expected);
    await expect(paper).toContainText("Balance due");
    await expect(paper).toContainText("7.50");
    await expect(paper.getByTestId("receipt-returned")).toHaveCount(0);
    await page.unroute(/\/api\/v1\/orders\/counter-sale\/today/);
    await page.unroute(/\/api\/v1\/orders\/e2e-o1$/);
  }
});
