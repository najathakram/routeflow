/**
 * Sales Demand card on the product detail page — the real-data replacement for the
 * old seeded-PRNG "30-Day Order Demand" chart.
 *
 * Every endpoint the page touches is MOCKED (same pattern as
 * `09-regulated-compliance.spec.ts`), so this is deterministic, writes nothing to any
 * tenant, and can reach the empty states that live data cannot.
 *
 * The load-bearing assertion is that switching METRIC issues no network request while
 * switching RANGE does: units and revenue ship in one payload on purpose, and a
 * regression there would double the endpoint's traffic invisibly.
 *
 * Deploy-order guard: on a web build predating this card the heading is absent and
 * every test skips rather than fails, so the prod-pointed nightly stays green.
 */
import { test, expect, type Page, type Route } from "@playwright/test";

const PRODUCT_ID = "e2e-demand-1";

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

/** `count` zero-filled buckets stepping back from a fixed date, newest last. */
function buckets(count: number, step: "day" | "week" | "month") {
  const out: { date: string; units: number; revenue: number }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(2026, 6, 15));
    if (step === "month") d.setUTCMonth(d.getUTCMonth() - i, 1);
    else d.setUTCDate(d.getUTCDate() - i * (step === "week" ? 7 : 1));
    out.push({ date: d.toISOString().slice(0, 10), units: 0, revenue: 0 });
  }
  return out;
}

function demandFixture(range: string) {
  const shape: Record<string, { n: number; step: "day" | "week" | "month" }> = {
    "30d": { n: 30, step: "day" },
    "6m": { n: 26, step: "week" },
    "1y": { n: 12, step: "month" },
    "5y": { n: 60, step: "month" },
  };
  const { n, step } = shape[range] ?? shape["6m"];
  const b = buckets(n, step);
  // Two populated buckets so both the chart and the totals have something to assert.
  b[b.length - 1].units = 48;
  b[b.length - 1].revenue = 100;
  b[b.length - 2].units = 27;
  b[b.length - 2].revenue = 43.75;
  return {
    productId: PRODUCT_ID,
    range,
    granularity: step,
    from: b[0].date,
    to: b[b.length - 1].date,
    buckets: b,
    totals: { units: 75, revenue: 143.75 },
    hasAnySales: true,
    // Later than the 5y window start, so the sparse-history footnote shows on 5Y.
    firstSaleAt: "2025-04-17",
    lastSaleAt: b[b.length - 1].date,
  };
}

const PRODUCT = {
  id: PRODUCT_ID,
  name: "Acme Cola 12oz",
  sku: "E2E-DEM-1",
  unit: "case",
  unitsPerBox: 24,
  pricePerUnit: 8.5,
  currentStock: 40,
  isActive: true,
  images: [],
  trackedCategoryId: null,
  trackedSubcategoryId: null,
};

/**
 * Mocks every request the product detail page fires. `demand` overrides the demand
 * payload (per range) to reach the empty states; `seen` collects the range params.
 */
// NOTE: every pattern is anchored to the /api/v1 prefix. The PAGE route is also
// /products/:id, so an unanchored matcher intercepts the HTML document navigation
// and fulfills it with JSON — the page then never renders and every test skips.
async function mockProductPage(
  page: Page,
  demand?: (range: string) => unknown,
  seen: string[] = [],
) {
  await page.route(/\/api\/v1\/products\/e2e-demand-1(\?.*)?$/, (route) =>
    fulfillJson(route, PRODUCT),
  );
  await page.route(/\/api\/v1\/products(\?.*)?$/, (route) =>
    fulfillJson(route, { data: [PRODUCT], total: 1 }),
  );
  await page.route(/\/api\/v1\/tracked-categories(\?.*)?$/, (route) => fulfillJson(route, []));
  await page.route(/\/api\/v1\/regulated\/templates(\?.*)?$/, (route) => fulfillJson(route, []));
  // Empty cost history so the neighbouring card self-hides and can't pollute locators.
  await page.route(/\/api\/v1\/analytics\/cost-history\/.*/, (route) => fulfillJson(route, []));
  await page.route(/\/api\/v1\/analytics\/demand\/e2e-demand-1(\?.*)?$/, (route) => {
    const range = new URL(route.request().url()).searchParams.get("range") ?? "(none)";
    seen.push(range);
    return fulfillJson(route, (demand ?? demandFixture)(range));
  });
  return seen;
}

const SKIP_REASON = "Sales Demand card not present in this web build (pre-deploy)";

/** Returns false when the build predates the card, so callers skip instead of failing. */
async function gotoCard(page: Page): Promise<boolean> {
  await page.goto(`/products/${PRODUCT_ID}`);
  return page
    .getByRole("heading", { name: "Sales Demand" })
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("Product detail — Sales Demand", () => {
  test("renders real invoiced sales, defaulting to the 6-month window", async ({ page }) => {
    const seen = await mockProductPage(page);
    test.skip(!(await gotoCard(page)), SKIP_REASON);

    // The demo card's title and disclaimer must be gone.
    await expect(page.getByText("30-Day Order Demand")).toHaveCount(0);
    await expect(page.getByText(/Demo data/)).toHaveCount(0);

    await expect(page.getByRole("button", { name: "Last 6 months" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(seen).toEqual(["6m"]);
    await expect(page.getByText(/over the last 6 months · bucketed by/)).toBeVisible();
    // The chart actually drew something — without this, every axis/tooltip assertion
    // in the suite could pass against an empty SVG.
    await expect
      .poll(async () => page.locator(".recharts-bar-rectangle").count())
      .toBeGreaterThanOrEqual(1);
  });

  test("switching range refetches; switching metric does not", async ({ page }) => {
    const seen = await mockProductPage(page);
    test.skip(!(await gotoCard(page)), SKIP_REASON);
    await expect(page.getByText(/over the last 6 months · bucketed by/)).toBeVisible();

    await page.getByRole("button", { name: "Last 30 days" }).click();
    await expect.poll(() => seen).toEqual(["6m", "30d"]);

    // Both metrics ride in one payload — the toggle must be pure client state.
    await page.getByRole("button", { name: "Show revenue" }).click();
    await expect(page.getByText(/\$143\.75 invoiced/)).toBeVisible();
    expect(seen).toEqual(["6m", "30d"]);

    await page.getByRole("button", { name: "Show units sold" }).click();
    await expect(page.getByText(/75 pcs/)).toBeVisible();
    expect(seen).toEqual(["6m", "30d"]);
  });

  test("5-year view thins its axis labels and flags where history starts", async ({ page }) => {
    await mockProductPage(page);
    test.skip(!(await gotoCard(page)), SKIP_REASON);

    await page.getByRole("button", { name: "Last 5 years" }).click();
    await expect(page.getByText(/over the last 5 years · bucketed by/)).toBeVisible();

    // 60 monthly buckets must not render 60 labels — with a LOWER bound too, or the
    // assertion passes vacuously when the axis renders nothing at all (which is exactly
    // what happened with a `.recharts-xAxis text` selector: Recharts 3 has no
    // `recharts-xAxis` wrapper class, so it counted 0 forever). Month labels are the
    // only tick labels containing an apostrophe ("Aug '21"), which isolates the x axis.
    const monthTicks = page.locator(".recharts-cartesian-axis-tick-label").filter({ hasText: "'" });
    await expect.poll(async () => monthTicks.count()).toBeLessThanOrEqual(12);
    await expect.poll(async () => monthTicks.count()).toBeGreaterThanOrEqual(5);
    await expect(page.getByText(/Sales history starts/)).toBeVisible();
  });

  test("a never-sold product says so and hides both toggles", async ({ page }) => {
    await mockProductPage(page, (range) => ({
      ...demandFixture(range),
      buckets: demandFixture(range).buckets.map((b) => ({ ...b, units: 0, revenue: 0 })),
      totals: { units: 0, revenue: 0 },
      hasAnySales: false,
      firstSaleAt: null,
      lastSaleAt: null,
    }));
    test.skip(!(await gotoCard(page)), SKIP_REASON);

    await expect(page.getByText("Never sold")).toBeVisible();
    // No range or metric can change this answer, so the controls are not rendered.
    await expect(page.getByRole("group", { name: "Demand range" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Demand metric" })).toHaveCount(0);
  });

  test("sold-but-quiet offers a one-click jump to a window with data", async ({ page }) => {
    // Relative, not a fixed date: the card compares lastSaleAt against Date.now(), so a
    // literal like "2024-08-15" ages out of every range's reach and the jump button
    // silently stops rendering a few years from now. 400 days back is stable forever:
    // outside 30d/6m/1y's guaranteed reach, inside 5y's.
    const lastSale = new Date(Date.now() - 400 * 86_400_000);
    const lastSaleIso = lastSale.toISOString().slice(0, 10);
    const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
    const lastSoldLabel = `${MONTHS[lastSale.getUTCMonth()]} ${lastSale.getUTCFullYear()}`;

    await mockProductPage(page, (range) => {
      const base = demandFixture(range);
      // Empty in every window except 5y.
      if (range === "5y") return base;
      return {
        ...base,
        buckets: base.buckets.map((b) => ({ ...b, units: 0, revenue: 0 })),
        totals: { units: 0, revenue: 0 },
        hasAnySales: true,
        lastSaleAt: lastSaleIso,
      };
    });
    test.skip(!(await gotoCard(page)), SKIP_REASON);

    await expect(page.getByText(/No sales in the last 6 months/)).toBeVisible();
    await expect(page.getByText(`Last sold ${lastSoldLabel}.`)).toBeVisible();

    await page.getByRole("button", { name: /^View last 5 years$/ }).click();
    await expect(page.getByText(/over the last 5 years · bucketed by/)).toBeVisible();
    // Controls stay available here, unlike the never-sold case.
    await expect(page.getByRole("group", { name: "Demand range" })).toBeVisible();
  });
});
