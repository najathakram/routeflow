/**
 * Shared network safety for the mocked `bo-web-*` Backoffice specs.
 *
 * Those specs fake a super-admin token the page only decodes client-side. Any API read they forget to mock goes to
 * the real local API, which answers the fake token with a 401; the app then wipes the tokens and redirects to
 * /admin-login, and the whole spec fails far from its cause. So: call `mockUnmockedBackoffice(page)` FIRST (the
 * routes registered after it win), then mock what the spec needs, and `mockOverviewReads(page)` for the reads the
 * tenant page makes on its own (the plan catalog behind the Overview plan control, and the stored config values).
 *
 * An unmocked read is answered with a 404 (never a 401, never real network) and recorded as a test annotation so it
 * shows in the report. No write is ever answered with success here.
 */
import { test, type Page, type Route } from "@playwright/test";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-tenant-slug",
};

function json(route: Route, body: unknown, status = 200) {
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

/** Catch-all for API calls (fetch/xhr only) the spec did not mock: a 404 plus an annotation, never real network. */
export async function mockUnmockedBackoffice(page: Page): Promise<void> {
  await page.route(/\/(platform-admin|billing)\//, (route) => {
    const type = route.request().resourceType();
    if (type !== "fetch" && type !== "xhr") return route.fallback();
    test.info().annotations.push({
      type: "unmocked-request",
      description: `${route.request().method()} ${route.request().url()}`,
    });
    return json(route, { message: "not mocked by this spec" }, 404);
  });
}

const PLAN = (planKey: string, sortOrder: number) => ({
  planKey,
  name: planKey,
  monthlyPrice: "0",
  annualPrice: null,
  isCustom: false,
  sortOrder,
});

/** The reads the tenant page makes by itself on Overview and Setup: `GET /billing/plans` and the stored config values. */
export async function mockOverviewReads(
  page: Page,
  tenantId: string,
  configValues: Record<string, string> = { fulfilment_model: "unset", counter_sales: "unset" },
): Promise<void> {
  await page.route(/\/billing\/plans(\?.*)?$/, (route) =>
    json(route, {
      version: 1,
      effectiveAt: null,
      plans: [PLAN("STARTER", 1), PLAN("GROWTH", 2), PLAN("SCALE", 3)],
    }),
  );
  await page.route(
    new RegExp(`/platform-admin/tenants/${tenantId}/feature-config/[a-z_]+$`),
    (route) => {
      const key = route.request().url().split("/").pop()!.split("?")[0]!;
      return json(route, { key, value: configValues[key] ?? "unset" });
    },
  );
}
