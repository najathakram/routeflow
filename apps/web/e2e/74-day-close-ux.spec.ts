/**
 * Rows 342 + 345 (day close UX): the hand-over stamp, Today's sales hand-over rows, the close form, the closed card, the Z
 * report and the counter screen at 1440 and 390. Read-only: every read the surfaces make is mocked (the shapes are the
 * contract's own), so nothing is written to the tenant. Role: OPERATOR (pre-authed storage state). Screenshots go to
 * local-assets/proofs/row342-345/ (a PROOF folder, git-ignored).
 */
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";

const SHOTS = path.join(__dirname, "..", "..", "..", "local-assets", "proofs", "row342-345");
const VIEWS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const;
const ZONE = "America/New_York";

const TOTALS = {
  salesCount: 2,
  salesTotal: 45,
  moneyIn: { cash: 30, card: 15, check: 0, other: 0, total: 45 },
  refunds: {
    count: 0,
    cash: 0,
    card: 0,
    check: 0,
    other: 0,
    total: 0,
    tenderKnown: true,
    unknownTenderCount: 0,
  },
  storeCreditUsed: 0,
  storeCreditIssued: { count: 0, amount: 0 },
  onAccount: 0,
  netCollected: 45,
  notAtTill: 12.5,
  handOver: { count: 1, cash: 18.94 },
};
const SNAPSHOT = {
  id: "dc1",
  registerKey: "main",
  day: "2026-10-11",
  zone: ZONE,
  windowStart: "2026-10-11T12:05:00.000Z",
  windowEnd: "2026-10-12T01:42:00.000Z",
  closedAt: "2026-10-12T01:42:00.000Z",
  closedById: "u1",
  closedByName: "Pat",
  openingFloat: 100,
  expectedCash: 130,
  countedCash: 127.5,
  variance: -2.5,
  denominations: [{ kind: "bill", value: 100, count: 1 }],
  totals: TOTALS,
  notes: null,
  reopenedAt: null,
  reopenedById: null,
  reportSent: true,
};
const PREVIEW = {
  windowStart: "2026-10-11T12:05:00.000Z",
  windowEnd: "2026-10-12T01:42:00.000Z",
  suggestedOpeningFloat: 100,
  tillCash: 30,
  cashRefunds: 0,
  totals: TOTALS,
};
const SALE = {
  orderId: "e2e-o1",
  invoiceId: "e2e-i1",
  orderNumber: "ORD-00011",
  invoiceNumber: "INV-00011",
  createdAt: "2026-10-11T18:46:00.000Z",
  total: 22.5,
  paid: 22.5,
  balanceDue: 0,
  customerId: "c1",
  customerName: null,
  isWalkIn: true,
  status: "DELIVERED",
  paymentState: "PAID",
  methods: [{ method: "CASH", amount: 22.5 }],
  returned: { amount: 0, state: "NONE", returns: [] },
  voided: false,
};
const TODAY = (closed: boolean) => ({
  data: [SALE],
  meta: {
    total: 1,
    page: 1,
    limit: 25,
    totalPages: 1,
    day: "2026-10-11",
    timezone: ZONE,
    windowStart: "2026-10-11T04:00:00.000Z",
    windowEnd: "2026-10-12T04:00:00.000Z",
  },
  summary: {
    sales: { count: 1, total: 22.5 },
    moneyIn: { cash: 41.44, card: 0, check: 0, other: 0, total: 41.44 },
    handOvers: { count: 1, total: 18.94 },
    storeCreditUsed: 0,
    onAccount: 0,
    refunds: { count: 0, cash: 0, card: 0, check: 0, other: 0, total: 0, tenderKnown: true },
    storeCreditIssued: { count: 0, amount: 0 },
    cashExpectedInDrawer: 41.44,
    netCollected: 41.44,
  },
  handOverRows: [
    {
      orderId: "e2e-po1",
      orderNumber: "ORD-00008",
      customerName: "Harbor Cafe",
      paidAt: "2026-10-11T18:20:00.000Z",
      amount: 18.94,
      methods: [{ method: "CASH", amount: 18.94 }],
      registerKey: "main",
      handedOverBy: "Pat",
    },
  ],
  ...(closed ? {} : {}),
});
const PICKUP_ORDER = {
  id: "e2e-po1",
  orderNumber: "ORD-00008",
  customerId: "c1",
  customer: { id: "c1", businessName: "Harbor Cafe" },
  status: "DELIVERED",
  fulfillPath: "PICKUP",
  cancelBlockedReason: null,
  editWindow: { editable: false },
  urgent: false,
  subtotal: 18.94,
  tax: 0,
  total: 18.94,
  lineItems: [],
  createdAt: "2026-10-11T17:00:00.000Z",
  deliveredAt: "2026-10-11T18:20:00.000Z",
  registerKey: "main",
  handedOverBy: "Pat",
  soldBy: { username: "Pat" },
};

async function mockCounter(page: Page, state: "open" | "closed") {
  // the till is on for this tenant: the real features answer with the fulfilment capability set to counter "always"
  await page.route(/\/api\/v1\/tenants\/me\/features$/, async (r) => {
    const res = await r.fetch();
    const json = await res.json().catch(() => ({}));
    const fulfilment = json?.capabilities?.fulfilment ?? {};
    await r.fulfill({
      json: {
        ...json,
        capabilities: {
          ...(json?.capabilities ?? {}),
          fulfilment: {
            ...fulfilment,
            counter: "always",
            methods: ["PICKUP", "SHIP"],
            staffDefault: "PICKUP",
          },
        },
      },
    });
  });
  await page.route(/\/api\/v1\/orders\/counter-sale\/today/, (r) =>
    r.fulfill({ json: TODAY(state === "closed") }),
  );
  await page.route(/\/api\/v1\/orders\/counter-sale\/day-close\/dc1\/report/, (r) =>
    r.fulfill({ json: { reportSent: true } }),
  );
  await page.route(/\/api\/v1\/orders\/counter-sale\/day-close$/, (r) =>
    r.request().method() === "GET"
      ? r.fulfill({
          json: {
            registerKey: "main",
            zone: ZONE,
            lastClose: state === "closed" ? SNAPSHOT : null,
            salesSince: state === "closed" ? 1 : 0,
            preview: PREVIEW,
          },
        })
      : r.fulfill({ json: SNAPSHOT }),
  );
  await page.route(/\/api\/v1\/orders\/e2e-o1$/, (r) =>
    r.fulfill({
      json: {
        id: "e2e-o1",
        orderNumber: "ORD-00011",
        customerId: "c1",
        total: 22.5,
        status: "DELIVERED",
        lineItems: [{ id: "l1", name: "Cola", qty: 9, unitPrice: 2.5 }],
      },
    }),
  );
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

for (const v of VIEWS) {
  test.describe(`at ${v.name}`, () => {
    test.beforeEach(async ({ page, context, baseURL }) => {
      await setTenantCookie(context, baseURL ?? "");
      await page.setViewportSize({ width: v.width, height: v.height });
    });

    test("row 342 (2): Today's sales lists the POS pickup hand-over", async ({ page }) => {
      await mockCounter(page, "open");
      await page.goto("/orders/counter-sale");
      await page.getByRole("button", { name: "Today's sales" }).click();
      await expect(page.getByTestId("today-summary")).toBeVisible();
      await expect(page.getByText("ORD-00008")).toBeVisible();
      await expect(page.getByText(/Pat/).first()).toBeVisible();
      await noOverflow(page);
      await page.screenshot({ path: path.join(SHOTS, `todays-sales-handover-${v.name}.png`) });
    });

    test("row 342 (1): the order detail's staff stamp reads cashier, register and time", async ({
      page,
    }) => {
      await page.route(/\/api\/v1\/orders\/e2e-po1$/, (r) => r.fulfill({ json: PICKUP_ORDER }));
      await page.route(/\/api\/v1\/settings$/, async (r) => {
        const res = await r.fetch();
        const json = await res.json().catch(() => ({}));
        await r.fulfill({ json: { ...json, timezone: ZONE } });
      });
      await page.goto("/orders/e2e-po1");
      const stamp = page.getByTestId("hand-over-stamp");
      await expect(stamp).toHaveText("Handed over by Pat · main · Oct 11, 2026, 2:20 PM");
      await noOverflow(page);
      await page.screenshot({ path: path.join(SHOTS, `order-detail-stamp-${v.name}.png`) });
    });

    test("row 345: the close form leads with a sticky variance hero, neutral until a count", async ({
      page,
    }) => {
      await mockCounter(page, "open");
      await page.goto("/orders/counter-sale");
      await page.getByRole("button", { name: "Today's sales" }).click();
      await page.getByRole("button", { name: "Close day" }).click();
      const hero = page.getByTestId("close-variance");
      await expect(hero).toBeVisible();
      const before = await hero.evaluate((el) => getComputedStyle(el).color);
      expect(
        await hero.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      ).toBeGreaterThanOrEqual(22);
      await expect(page.getByText("Expected cash")).toBeVisible();
      await expect(page.getByTestId("close-not-at-till")).toHaveText("Unpaid pickups: $12.50");
      const x = page
        .getByRole("dialog")
        .getByRole("button", { name: "Close", exact: true })
        .first();
      // layout size (offset*), not the bounding box: the dialog's open animation scales it for a moment
      const size = await x.evaluate((el) => ({
        w: (el as HTMLElement).offsetWidth,
        h: (el as HTMLElement).offsetHeight,
      }));
      expect(size.w).toBeGreaterThanOrEqual(44);
      expect(size.h).toBeGreaterThanOrEqual(44);
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(SHOTS, `close-form-neutral-${v.name}.png`) });
      await page.getByLabel("$20 bill count").fill("1");
      await expect(hero).toHaveText(/Short \$/);
      const after = await hero.evaluate((el) => getComputedStyle(el).color);
      expect(after).not.toBe(before);
      // scrolled to the bottom of the sheet, the hero is still in view
      await page.getByLabel("Notes").scrollIntoViewIfNeeded();
      await expect(hero).toBeInViewport();
      await page.screenshot({ path: path.join(SHOTS, `close-form-counted-${v.name}.png`) });
    });

    test("row 345: the closed card and the Z report read in the owner's words", async ({
      page,
    }) => {
      await mockCounter(page, "closed");
      await page.goto("/orders/counter-sale");
      await page.getByRole("button", { name: "Today's sales" }).click();
      const card = page.getByTestId("day-close-closed");
      await expect(card).toContainText("Short $2.50");
      await expect(card).toContainText("Z report emailed to admins");
      await expect(card.getByText("Expected cash")).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `closed-card-${v.name}.png`) });
      await card.getByRole("button", { name: "View Z report" }).click();
      const z = page.getByRole("dialog", { name: /Z report · / });
      await expect(z.getByTestId("z-headline")).toHaveText("Short $2.50");
      await expect(z.getByTestId("z-counted")).toHaveText("Counted $127.50");
      // the Drawer sits directly under the headline
      const order = await z
        .locator("[data-testid^='z-group-']")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
      expect(order[0]).toBe("z-group-Drawer");
      await expect(z.getByTestId("z-row-Unpaid pickups")).toContainText("$12.50");
      await expect(z.getByTestId("z-row-Pickup hand-overs (in till cash)")).toContainText(
        "$18.94 · 1 hand-over",
      );
      // the footer is pinned: Print, Email, Close, in reach without scrolling
      const actions = z.getByTestId("z-actions");
      await expect(actions.getByRole("button")).toHaveText(["Print", "Email", "Close"]);
      await expect(actions).toBeInViewport();
      // focus opens on the title, not on the ×
      expect(await page.evaluate(() => document.activeElement?.tagName.toLowerCase())).toBe("h2");
      await page.waitForTimeout(700); // let the sheet's open animation settle before the pixels are read
      await page.screenshot({ path: path.join(SHOTS, `z-report-${v.name}.png`) });
      await actions.getByRole("button", { name: "Email" }).click();
      await expect(z.getByTestId("z-resend-status")).toHaveText("Z report emailed to admins");
    });

    test("row 342 + 345: the reprint reads Sold <weekday, date, time>", async ({ page }) => {
      await mockCounter(page, "open");
      await page.goto("/orders/counter-sale");
      await page.getByRole("button", { name: "Today's sales" }).click();
      await page.getByTestId("today-row-e2e-o1").getByRole("button", { name: "Reprint" }).click();
      await expect(page.getByTestId("receipt-reprint")).toContainText(
        "Reprint · Sold Sun, Oct 11, 2:46 PM",
      );
      await page.screenshot({ path: path.join(SHOTS, `reprint-${v.name}.png`) });
    });

    test("row 345: the counter screen says Total, Amount due and a short scan prompt", async ({
      page,
    }) => {
      await mockCounter(page, "open");
      await page.goto("/orders/counter-sale");
      const scan = page.getByLabel("Scan or search items");
      await expect(scan).toHaveAttribute("placeholder", "Scan or type an item");
      await expect(page.getByTestId("scan-hint")).toBeVisible();
      await expect(page.getByTestId("running-total")).toContainText("Total");
      await expect(page.getByTestId("running-total")).not.toContainText("Estimated");
      await noOverflow(page);
      await page.screenshot({ path: path.join(SHOTS, `counter-screen-${v.name}.png`) });
    });
  });
}
