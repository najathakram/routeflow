/**
 * Feature grants PR-1 — the Overrides section on the platform-admin tenant detail page's
 * Addons & Features tab (/admin/tenants/[id]). Every endpoint the page touches to reach that
 * tab is MOCKED (same pattern as 09-regulated-compliance.spec.ts's mockRegulatedApi), so the
 * suite is deterministic and needs no live API/DB — just the "super-admin" storageState project
 * (skips everywhere PLAYWRIGHT_SA_* is unset, same as 01-super-admin.spec.ts).
 *
 * Proof required by owner ruling (2026-09-15, Playwright proof for all UI): a screenshot per
 * state at each of 1440/768/390, for independent visual review before merge.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { HAS_SUPER_ADMIN_CREDS } from "./helpers/constants";

test.skip(!HAS_SUPER_ADMIN_CREDS, "PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD not set");

const TENANT_ID = "e2e-fo-tenant-1";

function tenantFixture() {
  return {
    id: TENANT_ID,
    slug: "e2e-fo-tenant",
    name: "E2E Feature Overrides Tenant",
    status: "ACTIVE",
    plan: "GROWTH",
    trialEndsAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    businessName: "E2E Feature Overrides Tenant",
    primaryColor: null,
    logoKey: null,
    addressLine1: null,
    city: null,
    state: null,
    zip: null,
    country: null,
    phone: null,
    subscription: null,
    counts: null,
  };
}

const REGISTRY_FIXTURE = [
  {
    key: "tobacco_dealer",
    label: "Regulated items (tobacco)",
    area: "compliance",
    kind: "boolean",
    internal: false,
  },
  {
    key: "recurring_routes",
    label: "Recurring routes",
    area: "routes",
    kind: "boolean",
    internal: false,
  },
  {
    key: "developer_mode",
    label: "Developer mode",
    area: "platform",
    kind: "boolean",
    internal: true,
  },
];

function overrideRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ov-e2e-1",
    tenantId: TENANT_ID,
    featureKey: "tobacco_dealer",
    effect: "GRANT",
    reason: "Pilot: waived while onboarding",
    expiresAt: null,
    createdById: "admin-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

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

/** Installs mocks for every endpoint the tenant detail page's Overview + Addons tabs touch. */
async function mockTenantShell(page: Page) {
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}$`), (route) =>
    fulfillJson(route, tenantFixture()),
  );
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}/addons(\\?.*)?$`), (route) =>
    fulfillJson(route, []),
  );
  await page.route(/\/platform-admin\/features\/registry(\?.*)?$/, (route) =>
    fulfillJson(route, REGISTRY_FIXTURE),
  );
  // OverviewTab's recent-audit-logs fetch (.catch(() => {}) swallows a failure) — mocked anyway
  // so the tab shows a clean empty list instead of racing an unmocked request.
  await page.route(/\/platform-admin\/audit-logs(\?.*)?$/, (route) =>
    fulfillJson(route, { data: [], meta: { total: 0, pages: 1 } }),
  );
}

async function mockOverridesList(page: Page, body: unknown, status = 200) {
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}/feature-overrides$`), (route) =>
    fulfillJson(route, body, status),
  );
}

async function gotoOverridesSection(page: Page) {
  await page.goto(`/admin/tenants/${TENANT_ID}`);
  await page.getByRole("button", { name: "Addons & Features" }).click();
  await expect(page.getByRole("heading", { name: "Overrides" })).toBeVisible({ timeout: 15_000 });
}

const STATES: Array<{
  name: string;
  body: unknown;
  status?: number;
  assert: (page: Page) => Promise<void>;
}> = [
  {
    name: "empty",
    body: [],
    assert: async (page) => {
      await expect(page.getByText("No active overrides.")).toBeVisible();
    },
  },
  {
    name: "one-grant",
    body: [overrideRow({ effect: "GRANT" })],
    assert: async (page) => {
      await expect(page.getByText("tobacco_dealer")).toBeVisible();
      await expect(page.getByText("GRANT")).toBeVisible();
      await expect(page.getByText("Active")).toBeVisible();
    },
  },
  {
    name: "one-deny",
    body: [overrideRow({ id: "ov-e2e-2", featureKey: "recurring_routes", effect: "DENY" })],
    assert: async (page) => {
      await expect(page.getByText("recurring_routes")).toBeVisible();
      await expect(page.getByText("DENY")).toBeVisible();
    },
  },
  {
    name: "expired",
    body: [overrideRow({ id: "ov-e2e-3", expiresAt: "2020-01-01T00:00:00.000Z" })],
    assert: async (page) => {
      await expect(page.getByText("Expired")).toBeVisible();
    },
  },
  {
    name: "error",
    body: { message: "Internal error" },
    status: 500,
    assert: async (page) => {
      await expect(page.getByText("Failed to load feature overrides.")).toBeVisible();
    },
  },
];

const VIEWPORTS = [
  { label: "1440", width: 1440, height: 900 },
  { label: "768", width: 768, height: 1024 },
  { label: "390", width: 390, height: 844 },
];

for (const vp of VIEWPORTS) {
  test.describe(`Feature overrides — ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const state of STATES) {
      test(`${vp.label}px — ${state.name}`, async ({ page }) => {
        await mockTenantShell(page);
        await mockOverridesList(page, state.body, state.status);
        await gotoOverridesSection(page);
        await state.assert(page);
        await page.screenshot({
          path: `test-output/feature-overrides/${vp.label}-${state.name}.png`,
        });
      });
    }
  });
}
