/**
 * CSV exports "then and there": products list export popover, the per-card analytics CSV
 * buttons, and the product-detail sales export.
 *
 * Every endpoint is MOCKED (same pattern as `11-product-demand.spec.ts`), so this is
 * deterministic and writes nothing to any tenant. The mocked export bodies stand in for the
 * server's streamed CSV; what is asserted for real is the browser side — the suggested
 * filename, the UTF-8 BOM surviving to disk, the request params the UI sends, the
 * nothing-to-export path, and (analytics, which builds its file client-side) the
 * formula-injection guard.
 *
 * Runs at a desktop (1440) and a phone (390) viewport. Self-skips on web builds that predate
 * a control, so the prod-pointed nightly stays green.
 */
import * as fs from "fs";
import { test, expect, type Page, type Route } from "@playwright/test";

const PRODUCT_ID = "e2e-csv-1";
const EVIL = "=cmd|' /C calc'!A0";
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-tenant-slug",
  "access-control-expose-headers": "content-disposition",
};

function preflight(route: Route) {
  return route.fulfill({ status: 204, headers: CORS_HEADERS });
}
function fulfillJson(route: Route, body: unknown) {
  if (route.request().method() === "OPTIONS") return preflight(route);
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  });
}
function fulfillCsv(route: Route, body: string, disposition?: string) {
  if (route.request().method() === "OPTIONS") return preflight(route);
  return route.fulfill({
    status: 200,
    contentType: "text/csv; charset=utf-8",
    headers: { ...CORS_HEADERS, ...(disposition ? { "content-disposition": disposition } : {}) },
    body,
  });
}

const PRODUCT = {
  id: PRODUCT_ID,
  name: "Acme Cola 12oz",
  sku: "E2E-CSV-1",
  unit: "case",
  unitsPerBox: 24,
  pricePerUnit: 8.5,
  currentStock: 40,
  isActive: true,
  images: [],
  trackedCategoryId: null,
  trackedSubcategoryId: null,
};

const EXPORT_BODY = `﻿SKU,Name,Units sold\r\nE2E-CSV-1,'${EVIL},4\r\n`;

/** Reads a Playwright download from disk. */
async function readDownload(download: import("@playwright/test").Download) {
  const p = await download.path();
  return fs.readFileSync(p);
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

async function mockProductsList(page: Page, total: number) {
  await page.route(/\/api\/v1\/products(\?.*)?$/, (route) =>
    fulfillJson(route, {
      data: total === 0 ? [] : [PRODUCT],
      meta: { total, page: 1, limit: 25, totalPages: 1 },
    }),
  );
}

async function mockAnalytics(page: Page) {
  const A = "\\/api\\/v1\\/analytics";
  const on = (tail: string, body: unknown) =>
    page.route(new RegExp(`${A}${tail}(\\?.*)?$`), (route) => fulfillJson(route, body));
  await on("\\/revenue", [
    { period: "2026-08", revenue: 1200.5 },
    { period: "2026-09", revenue: 980 },
  ]);
  await on("\\/aov", { aov: 87.25 });
  await on("\\/dso", { dso: 31.4, count: 12 });
  await on("\\/gross-margin", { revenue: 100, cogs: 60, grossProfit: 40, grossMarginPct: 40 });
  await on("\\/sales-by-category", [{ category: "Drinks", revenue: 500 }]);
  await on("\\/customers\\/top", [
    { id: "c1", name: EVIL, totalRevenue: 500, orderCount: 4 },
    { id: "c2", name: "Acme Retail", totalRevenue: 100, orderCount: 1 },
  ]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

for (const vp of [
  { name: "desktop 1440", width: 1440, height: 900 },
  { name: "phone 390", width: 390, height: 844 },
]) {
  test.describe(`CSV export — ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("products: filtered export sends filter + range, downloads a BOM'd CSV", async ({
      page,
    }) => {
      await mockProductsList(page, 42);
      await page.route(/\/api\/v1\/products\/export\.csv(\?.*)?$/, (route) =>
        fulfillCsv(route, EXPORT_BODY),
      );
      await page.goto("/products");
      const exportBtn = page.getByTestId("products-export-button");
      const present = await exportBtn
        .waitFor({ timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      test.skip(!present, "Products export not present in this web build (pre-deploy)");

      await page.getByPlaceholder("Name, SKU or scan barcode…").fill("cola");
      await expect(exportBtn).toContainText("42 products");
      await exportBtn.click();
      await expect(page.getByTestId("products-export-popover")).toBeVisible();

      // The popover must stay inside the viewport (was clipped at left = -59px at 390).
      const box = await page.getByTestId("products-export-popover").boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);

      const reqP = page.waitForRequest(/\/api\/v1\/products\/export\.csv/);
      const dlP = page.waitForEvent("download");
      await page.getByTestId("products-export-download").click();
      const [req, download] = await Promise.all([reqP, dlP]);

      const q = new URL(req.url()).searchParams;
      expect(q.get("search")).toBe("cola");
      expect(q.get("from")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(q.get("to")).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      expect(download.suggestedFilename()).toMatch(/^products-\d{4}-\d{2}-\d{2}\.csv$/);
      const buf = await readDownload(download);
      expect(buf.subarray(0, 3).equals(BOM)).toBe(true);
      const lines = buf.subarray(3).toString("utf8").split("\r\n");
      expect(lines[0]).toBe("SKU,Name,Units sold");
      // The server neutralises formula-leading names; the browser must hand them through intact.
      expect(lines[1]).toContain(`'${EVIL}`);
    });

    test("products: zero matches toasts Nothing to export and downloads nothing", async ({
      page,
    }) => {
      await mockProductsList(page, 0);
      let exportRequests = 0;
      await page.route(/\/api\/v1\/products\/export\.csv/, (route) => {
        exportRequests++;
        return fulfillCsv(route, EXPORT_BODY);
      });
      let downloads = 0;
      page.on("download", () => downloads++);
      await page.goto("/products");
      const exportBtn = page.getByTestId("products-export-button");
      const present = await exportBtn
        .waitFor({ timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      test.skip(!present, "Products export not present in this web build (pre-deploy)");

      await exportBtn.click();
      await page.getByTestId("products-export-download").click();
      await expect(page.getByText("Nothing to export").first()).toBeVisible();
      expect(exportRequests).toBe(0);
      expect(downloads).toBe(0);
    });

    test("analytics: a card's CSV has the range filename, BOM, header and a guarded name", async ({
      page,
    }) => {
      await mockAnalytics(page);
      await page.goto("/analytics");
      await page
        .getByRole("button", { name: "Customers" })
        .click({ timeout: 15_000 })
        .catch(() => undefined);
      const btn = page.getByTestId("analytics-csv-top-customers");
      const present = await btn
        .waitFor({ timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      test.skip(!present, "Analytics CSV buttons not present in this web build (pre-deploy)");

      await expect(btn).toBeEnabled();
      const dlP = page.waitForEvent("download");
      await btn.click();
      const download = await dlP;

      expect(download.suggestedFilename()).toMatch(
        /^analytics-top-customers-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/,
      );
      const buf = await readDownload(download);
      expect(buf.subarray(0, 3).equals(BOM)).toBe(true);
      const lines = buf.subarray(3).toString("utf8").split("\r\n");
      expect(lines[0]).toBe("#,Customer,Total revenue,Orders");
      expect(lines[1]).toBe(`1,'${EVIL},500,4`);
    });

    test("product detail: sales insights export downloads under the server's filename", async ({
      page,
    }) => {
      await page.route(/\/api\/v1\/products\/e2e-csv-1(\?.*)?$/, (route) =>
        fulfillJson(route, PRODUCT),
      );
      await mockProductsList(page, 1);
      await page.route(
        /\/api\/v1\/analytics\/products\/e2e-csv-1\/insights\.csv(\?.*)?$/,
        (route) =>
          fulfillCsv(
            route,
            "﻿Invoice,Buyer,Qty\r\nINV-1,Acme Retail,3\r\n",
            'attachment; filename="product-sales-E2E-CSV-1-2026-09-29.csv"',
          ),
      );
      await page.goto(`/products/${PRODUCT_ID}`);
      const btn = page.getByTestId("product-insights-export-button");
      const present = await btn
        .waitFor({ timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      test.skip(!present, "Insights export not present (pre-deploy or analytics plan flag off)");

      const dlP = page.waitForEvent("download");
      await btn.click();
      const download = await dlP;
      expect(download.suggestedFilename()).toBe("product-sales-E2E-CSV-1-2026-09-29.csv");
      const buf = await readDownload(download);
      expect(buf.subarray(0, 3).equals(BOM)).toBe(true);
      expect(buf.subarray(3).toString("utf8").split("\r\n")[0]).toBe("Invoice,Buyer,Qty");
    });
  });
}
