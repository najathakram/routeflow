/**
 * BO-06: the Setup console's mode radios render for gate-less config rows ("Where orders go"),
 * proved at 1440, 768 and 390.
 *
 * NOT RUN by the author (no stack in the build worktree). Every API call is mocked (the same
 * pattern as bo-web-console.spec.ts), the tenant is a throwaway `qa-*` slug, and no live tenant is
 * ever contacted. Auth is a locally faked super-admin token the page only decodes client-side.
 *
 * `PLAYWRIGHT_BASE_URL` has no default: `baseUrl()` throws when it is unset, so a forgotten
 * variable can never point this spec at a real site.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { mockOverviewReads, mockUnmockedBackoffice } from "./helpers/bo-api-mocks";

function baseUrl(): string {
  const value = process.env.PLAYWRIGHT_BASE_URL;
  if (value === undefined || value.trim() === "") {
    throw new Error(
      "PLAYWRIGHT_BASE_URL is not set. Point it at the local stack (http://localhost:3001); there is no default.",
    );
  }
  return value;
}

test.use({ baseURL: baseUrl() });

const TENANT_ID = "qa-bo-radios-1";
const PLAN_KEY = "SCALE";
const CATALOG_VERSION_ID = "catalog-v11";

function base64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function fakeSuperAdminToken(): string {
  const header = base64url({ alg: "none", typ: "JWT" });
  const payload = base64url({
    sub: "qa-fake-admin",
    role: "SUPER_ADMIN",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `${header}.${payload}.fake-signature`;
}

const MODE_ON_SHIP = {
  value: "ship",
  effective: "ship",
  source: "TENANT",
  allowed: ["unset", "delivery", "ship", "both"],
  blocked: [],
};

const FULFILMENT_ROW = {
  key: "fulfilment_model",
  kind: "boolean",
  area: "routes",
  label: "Where orders go",
  description: "Whether orders go out on delivery runs, ship by carrier, or both.",
  lifecycle: "ga",
  internal: false,
  gate: { via: "none", state: "none" },
  via: "none",
  billing: { skus: [] },
  config: {
    fallbackMode: "unset",
    modes: [
      { key: "unset", label: "Not configured (today's behavior)", lifecycle: "ga" },
      { key: "delivery", label: "Own delivery", lifecycle: "ga" },
      { key: "ship", label: "Ship by carrier", lifecycle: "ga" },
      { key: "both", label: "Delivery and shipping", lifecycle: "ga" },
    ],
  },
};

// A gate-less row with no config: it must never get radios.
const PLAIN_ROW = {
  key: "plain_setting",
  kind: "boolean",
  area: "routes",
  label: "Plain setting",
  description: "A setting with no mode.",
  lifecycle: "ga",
  internal: false,
  gate: { via: "none", state: "none" },
  via: "none",
  billing: { skus: [] },
};

// serving:false is what a gate-less config row really reports; that is the bug this card fixes.
const FULFILMENT_EFFECTIVE = {
  key: "fulfilment_model",
  area: "routes",
  serving: false,
  resolver: true,
  source: "PRESET",
  detail: { planKey: PLAN_KEY, catalogVersionId: CATALOG_VERSION_ID, enforced: false },
  billing: { charged: false },
  mode: MODE_ON_SHIP,
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,OPTIONS",
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

/** Mocks the tenant shell + console; returns the list of feature-config writes the page made. */
async function gotoConsole(page: Page) {
  const writes: string[] = [];
  // Registered first so every route below wins: an unmocked read must never reach the real API (its 401
  // wipes the fake token and redirects to /admin-login).
  await mockUnmockedBackoffice(page);
  await mockOverviewReads(page, TENANT_ID, { fulfilment_model: "ship", counter_sales: "unset" });
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}$`), (route) =>
    fulfillJson(route, {
      id: TENANT_ID,
      slug: "qa-bo-radios",
      name: "QA Backoffice Radios Tenant",
      status: "ACTIVE",
      plan: "BUSINESS",
      planKey: PLAN_KEY,
      trialEndsAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      businessName: "QA Backoffice Radios Tenant",
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
    }),
  );
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}/admin(\\?.*)?$`), (route) =>
    fulfillJson(route, { admin: null }),
  );
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}/addons(\\?.*)?$`), (route) =>
    fulfillJson(route, []),
  );
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}/feature-overrides$`), (route) =>
    fulfillJson(route, []),
  );
  await page.route(/\/platform-admin\/audit-logs(\?.*)?$/, (route) =>
    fulfillJson(route, { data: [], meta: { total: 0, pages: 1 } }),
  );
  await page.route(/\/platform-admin\/features\/registry(\?.*)?$/, (route) =>
    fulfillJson(route, [FULFILMENT_ROW, PLAIN_ROW]),
  );
  await page.route(
    new RegExp(`/platform-admin/tenants/${TENANT_ID}/features/effective(\\?.*)?$`),
    (route) => fulfillJson(route, { effective: [FULFILMENT_EFFECTIVE] }),
  );
  await page.route(/\/platform-admin\/features\/diffs(\?.*)?$/, (route) => fulfillJson(route, []));
  await page.route(/\/platform-admin\/entitlements\/mode(\?.*)?$/, (route) =>
    fulfillJson(route, { mode: "shadow" }),
  );
  await page.route(/\/platform-admin\/business-profiles(\?.*)?$/, (route) =>
    fulfillJson(route, { profiles: [] }),
  );
  await page.route(
    new RegExp(`/platform-admin/tenants/${TENANT_ID}/features/preview(\\?.*)?$`),
    (route) =>
      fulfillJson(route, {
        before: [FULFILMENT_EFFECTIVE],
        after: [
          {
            ...FULFILMENT_EFFECTIVE,
            mode: { ...MODE_ON_SHIP, value: "both", effective: "both" },
          },
        ],
        changed: ["fulfilment_model"],
      }),
  );
  // Any write is recorded and refused: Cancel must leave this list empty.
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}/feature-config/`), (route) => {
    // Reads fall through to mockOverviewReads; only writes are recorded and refused.
    if (route.request().method() === "GET") return route.fallback();
    if (route.request().method() !== "OPTIONS") writes.push(route.request().method());
    return fulfillJson(route, { message: "unexpected write" }, 500);
  });
  await page.addInitScript((token) => {
    window.localStorage.setItem("superAdminToken", token);
  }, fakeSuperAdminToken());
  await page.goto(`/admin/tenants/${TENANT_ID}`);
  await page.getByRole("button", { name: "Setup", exact: true }).click();
  await expect(page.locator('[data-feature-key="fulfilment_model"]')).toBeVisible({
    timeout: 15_000,
  });
  return writes;
}

const VIEWPORTS = [
  { label: "1440", width: 1440, height: 900 },
  { label: "768", width: 768, height: 1024 },
  { label: "390", width: 390, height: 844 },
];

for (const vp of VIEWPORTS) {
  test.describe(`Backoffice console mode radios, ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("the Where orders go row shows its radios, named by the label; a plain row has none", async ({
      page,
    }) => {
      await gotoConsole(page);
      const row = page.locator("#feature-fulfilment_model");
      const group = row.getByRole("radiogroup", { name: "Where orders go mode" });
      await expect(group).toBeVisible();
      await expect(group.getByRole("radio", { name: "Ship by carrier" })).toBeChecked();
      await expect(page.locator("#feature-plain_setting").getByRole("radiogroup")).toHaveCount(0);
    });

    test("selecting a mode opens the preview drawer and Cancel writes nothing", async ({
      page,
    }) => {
      const writes = await gotoConsole(page);
      const row = page.locator("#feature-fulfilment_model");
      await row.getByRole("radio", { name: "Delivery and shipping" }).check();
      await expect(page.getByRole("heading", { name: "Preview mode change" })).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("heading", { name: "Preview mode change" })).toHaveCount(0);
      expect(writes).toEqual([]);
    });
  });
}
