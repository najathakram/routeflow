/**
 * "Open orders" card on the product detail page: who has this product on an open order and how many
 * are still to be billed. Sits directly above the invoiced "Sales" card, staff only.
 *
 * Every endpoint the page touches is MOCKED (same pattern as `11-product-demand.spec.ts`), so this is
 * deterministic and writes nothing to any tenant.
 *
 * Deploy-order guard: on a web build predating the card the heading is absent and every test skips
 * rather than fails, so the prod-pointed nightly stays green.
 */
import path from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { findViewportOverflow } from "./helpers/overflow";

const PRODUCT_ID = "e2e-open-orders-1";
const SHOTS = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "local-assets",
  "proofs",
  "product-open-orders",
);

// ─── Mock plumbing ────────────────────────────────────────────────────────────

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

const PRODUCT = {
  id: PRODUCT_ID,
  name: "Acme Cola 12oz",
  sku: "E2E-OO-1",
  unit: "case",
  unitsPerBox: 24,
  pricePerUnit: 8.5,
  currentStock: 40,
  isActive: true,
  images: [],
  trackedCategoryId: null,
  trackedSubcategoryId: null,
};

const line = (over: Record<string, unknown>) => ({
  orderId: "o-1001",
  orderNumber: "ORD-1001",
  status: "PENDING",
  orderDate: "2026-10-12T00:00:00.000Z",
  customerId: "c-acme",
  customerName: "Acme Foods",
  qty: 48,
  remainingQty: 48,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 24,
  unitLabel: null,
  ...over,
});

const OPEN_ORDERS = {
  productId: PRODUCT_ID,
  lines: [
    line({}),
    line({
      orderId: "o-1002",
      orderNumber: "ORD-1002",
      status: "CONFIRMED",
      orderDate: "2026-10-10T00:00:00.000Z",
      customerId: "c-globex",
      customerName: "Globex Market",
      qty: 72,
      remainingQty: 30,
      boxes: 1,
      pieces: 6,
    }),
    line({
      orderId: "o-1003",
      orderNumber: "ORD-1003",
      status: "OUT_FOR_DELIVERY",
      orderDate: "2026-10-08T00:00:00.000Z",
      customerId: "c-acme",
      customerName: "Acme Foods",
      qty: 24,
      remainingQty: 24,
      boxes: 1,
      pieces: 0,
    }),
  ],
  summary: { orders: 3, customers: 2, totalQty: 102 },
  truncated: false,
};

// NOTE: every pattern is anchored to the /api/v1 prefix. The PAGE route is also /products/:id, so an
// unanchored matcher intercepts the HTML document navigation and the page never renders.
async function mockProductPage(page: Page) {
  const id = PRODUCT_ID;
  await page.route(new RegExp(`/api/v1/products/${id}(\\?.*)?$`), (route) =>
    fulfillJson(route, PRODUCT),
  );
  await page.route(new RegExp(`/api/v1/products/${id}/open-orders(\\?.*)?$`), (route) =>
    fulfillJson(route, OPEN_ORDERS),
  );
  await page.route(/\/api\/v1\/products(\?.*)?$/, (route) =>
    fulfillJson(route, { data: [PRODUCT], total: 1 }),
  );
  await page.route(/\/api\/v1\/tracked-categories(\?.*)?$/, (route) => fulfillJson(route, []));
  await page.route(/\/api\/v1\/regulated\/templates(\?.*)?$/, (route) => fulfillJson(route, []));
  await page.route(/\/api\/v1\/analytics\/cost-history\/.*/, (route) => fulfillJson(route, []));
  await page.route(new RegExp(`/api/v1/analytics/product-sales/${id}(\\?.*)?$`), (route) =>
    fulfillJson(route, {
      productId: id,
      lines: [],
      summary: {
        count: 0,
        buyers: 0,
        totalQty: 0,
        totalRevenue: 0,
        minPrice: null,
        maxPrice: null,
        avgPrice: null,
      },
    }),
  );
  await page.route(new RegExp(`/api/v1/analytics/demand/${id}(\\?.*)?$`), (route) =>
    fulfillJson(route, {
      productId: id,
      range: "6m",
      granularity: "week",
      from: "2026-04-15",
      to: "2026-10-15",
      buckets: [],
      totals: { units: 0, revenue: 0 },
      hasAnySales: false,
      firstSaleAt: null,
      lastSaleAt: null,
    }),
  );
}

const SKIP_REASON = "Open orders card not present in this web build (pre-deploy)";

/** Only a run against the deployed production web may predate the card; anywhere else it is a failure. */
const TARGETS_PROD = /production\.up\.railway\.app|routeflow\.info/.test(
  process.env.PLAYWRIGHT_BASE_URL ?? "",
);

/** Opens the product page. Skips (production, pre-deploy) or fails (everywhere else) without the card. */
async function gotoCard(page: Page): Promise<void> {
  await page.goto(`/products/${PRODUCT_ID}`);
  const heading = page.getByRole("heading", { name: "Open orders" });
  if (TARGETS_PROD) {
    const present = await heading
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!present, SKIP_REASON);
  } else {
    await heading.waitFor({ timeout: 15_000 });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("Product detail: Open orders", () => {
  test("lists the three mocked lines above Sales and links an order number to its order", async ({
    page,
  }) => {
    await mockProductPage(page);
    await gotoCard(page);

    const card = page
      .getByRole("heading", { name: "Open orders" })
      .locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
    await expect(card.getByRole("row")).toHaveCount(4); // header + 3 lines
    await expect(card.getByText("1 box + 6 pcs")).toBeVisible();
    await expect(card.getByText("of 3 boxes ordered")).toBeVisible();

    // Directly above the invoiced Sales card.
    const openBox = await page.getByRole("heading", { name: "Open orders" }).boundingBox();
    const salesBox = await page.getByRole("heading", { name: "Sales", exact: true }).boundingBox();
    expect(openBox && salesBox && openBox.y < salesBox.y).toBe(true);

    await card.getByRole("link", { name: "ORD-1002" }).click();
    await expect(page).toHaveURL(/\/orders\/o-1002$/);
  });

  for (const [name, width, height] of [
    ["390", 390, 844],
    ["768", 768, 1024],
    ["1280", 1280, 800],
  ] as const) {
    test(`no horizontal overflow at ${name}px, with a screenshot`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await mockProductPage(page);
      await gotoCard(page);

      const heading = page.getByRole("heading", { name: "Open orders" });
      await heading.scrollIntoViewIfNeeded();
      await expect(page.getByRole("link", { name: "ORD-1003" })).toBeVisible();
      const { offenders } = await findViewportOverflow(page);
      expect(offenders, `overflow at ${width}px: ${JSON.stringify(offenders.slice(0, 5))}`).toEqual(
        [],
      );
      await page.screenshot({ path: path.join(SHOTS, `open-orders-${name}.png`) });
    });
  }
});
