/**
 * BO-09, BO-10 (keep-the-picker fallback) and BO-12: the Backoffice Setup console, proved at
 * 1440, 768 and 390.
 *
 * NOT RUN by the author (no stack in the build worktree): written to run against
 * `npm run local:up` + `npm run local:e2e`-style env. Every API call is mocked (the same pattern as
 * 49-feature-console.spec.ts), the tenant is a throwaway `e2e-*` slug, and no live tenant is ever
 * contacted. Auth is a locally faked super-admin token the page only decodes client-side.
 *
 * `PLAYWRIGHT_BASE_URL` has no default: `baseUrl()` throws when it is unset, so a forgotten
 * variable can never point this spec at a real site.
 */
import { test, expect, type Locator, type Page, type Route } from "@playwright/test";

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

const TENANT_ID = "e2e-bo-console-1";
const PLAN_KEY = "SCALE";
const CATALOG_VERSION_ID = "catalog-v11";

function base64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function fakeSuperAdminToken(): string {
  const header = base64url({ alg: "none", typ: "JWT" });
  const payload = base64url({
    sub: "e2e-fake-admin",
    role: "SUPER_ADMIN",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `${header}.${payload}.fake-signature`;
}

// BO-10: the legacy enum says BUSINESS, the resolved plan says SCALE (what the header shows).
function tenantFixture() {
  return {
    id: TENANT_ID,
    slug: "e2e-bo-console",
    name: "E2E Backoffice Console Tenant",
    status: "ACTIVE",
    plan: "BUSINESS",
    planKey: PLAN_KEY,
    trialEndsAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    businessName: "E2E Backoffice Console Tenant",
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

const row = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  kind: "boolean",
  area: "bo",
  label: `Row ${key}`,
  description: `Description of ${key}.`,
  lifecycle: "ga",
  internal: false,
  gate: { via: "RequirePlanFlag", state: "enforced" },
  via: "RequirePlanFlag",
  billing: { skus: [] },
  ...over,
});

const REGISTRY = [
  row("tobacco_dealer", {
    label: "Regulated items (tobacco)",
    gate: { via: "RequireAddon", state: "enforced" },
    via: "RequireAddon",
    billing: { skus: ["tobacco_dealer"] },
  }),
  // The T1-style row: dark gate, no source, but served. Used to read "Off", "dark" and "On".
  row("t1_style", { gate: { via: "RequirePlanFlag", state: "dark" }, lifecycle: "beta" }),
  row("not_reported"),
  row("fulfilment_model", {
    label: "Where orders go",
    gate: { via: "none", state: "none" },
    via: "none",
    config: {
      fallbackMode: "unset",
      modes: [
        { key: "unset", label: "Not configured (today's behavior)", lifecycle: "ga" },
        { key: "delivery", label: "Own delivery", lifecycle: "ga" },
        { key: "ship", label: "Ship by carrier", lifecycle: "ga" },
      ],
    },
  }),
];

const effective = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  area: "bo",
  serving: false,
  resolver: false,
  source: "NONE",
  detail: { planKey: PLAN_KEY, catalogVersionId: CATALOG_VERSION_ID, enforced: true },
  billing: { charged: false },
  ...over,
});

const EFFECTIVE = [
  effective("tobacco_dealer", { source: "OVERRIDE_DENY", resolver: true }),
  effective("t1_style", { serving: true, source: "NONE" }),
  // not_reported: deliberately absent
  effective("fulfilment_model", {
    resolver: true,
    source: "PRESET",
    mode: {
      value: "ship",
      effective: "ship",
      source: "TENANT",
      allowed: ["unset", "delivery", "ship"],
      blocked: [],
    },
  }),
];

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

async function mockTenantShell(page: Page) {
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}$`), (route) =>
    fulfillJson(route, tenantFixture()),
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
    fulfillJson(route, REGISTRY),
  );
  await page.route(
    new RegExp(`/platform-admin/tenants/${TENANT_ID}/features/effective(\\?.*)?$`),
    (route) => fulfillJson(route, { effective: EFFECTIVE }),
  );
  await page.route(/\/platform-admin\/features\/diffs(\?.*)?$/, (route) => fulfillJson(route, []));
  await page.route(/\/platform-admin\/entitlements\/mode(\?.*)?$/, (route) =>
    fulfillJson(route, { mode: "shadow" }),
  );
  await page.route(/\/platform-admin\/business-profiles(\?.*)?$/, (route) =>
    fulfillJson(route, { profiles: [] }),
  );
}

async function gotoConsole(page: Page) {
  await mockTenantShell(page);
  await page.addInitScript((token) => {
    window.localStorage.setItem("superAdminToken", token);
  }, fakeSuperAdminToken());
  await page.goto(`/admin/tenants/${TENANT_ID}`);
  await page.getByRole("button", { name: "Setup", exact: true }).click();
  await expect(page.getByRole("heading", { name: "bo", exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

const rowLocator = (page: Page, key: string) => page.locator(`[data-feature-key="${key}"]`);

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("element has no box");
  return b;
}

const VIEWPORTS = [
  { label: "1440", width: 1440, height: 900 },
  { label: "768", width: 768, height: 1024 },
  { label: "390", width: 390, height: 844 },
];

for (const vp of VIEWPORTS) {
  test.describe(`Backoffice console, ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("BO-09: Set override is a quiet link and is absent where it does nothing", async ({
      page,
    }) => {
      await gotoConsole(page);
      // gate-less row: no Set override at all
      await expect(
        rowLocator(page, "fulfilment_model").getByRole("button", { name: /^Set override/ }),
      ).toHaveCount(0);
      // gated row: present, no fill
      const btn = rowLocator(page, "tobacco_dealer").getByRole("button", {
        name: /^Set override/,
      });
      await expect(btn).toBeVisible();
      const bg = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).toMatch(/^rgba\(0, 0, 0, 0\)|transparent$/);
      // tap size: >= 44 px below md, >= 24 px from md up
      const height = (await box(btn)).height;
      expect(height).toBeGreaterThanOrEqual(vp.width < 768 ? 44 : 24);
      // no filled indigo button anywhere on the console rows
      const filled = await page
        .locator("[data-feature-key] button")
        .evaluateAll(
          (els) =>
            els.filter((el) => getComputedStyle(el).backgroundColor === "rgb(79, 70, 229)").length,
        );
      expect(filled).toBe(0);
    });

    test("BO-10: the Tier picker marks the resolved plan, never the legacy enum", async ({
      page,
    }) => {
      await gotoConsole(page);
      const tier = page.getByLabel("Tier");
      await expect(tier).toHaveValue(PLAN_KEY);
      const options = await tier.locator("option").allTextContents();
      expect(options.some((o) => /business/i.test(o))).toBe(false);
      expect(options.filter((o) => /current/.test(o))).toEqual([expect.stringMatching(/Scale/)]);
      await expect(page.getByRole("button", { name: "Preview plan change" })).toBeDisabled();
    });

    test("BO-12: each row reads one state; the T1-style row is one amber readout", async ({
      page,
    }) => {
      await gotoConsole(page);
      for (const key of ["tobacco_dealer", "t1_style", "not_reported", "fulfilment_model"]) {
        await expect(rowLocator(page, key).getByTestId("readout")).toHaveCount(1);
        await expect(rowLocator(page, key).locator(".sr-only")).toHaveCount(0);
      }
      await expect(rowLocator(page, "t1_style").getByTestId("readout")).toHaveText(
        "On, not enforced yet",
      );
      await expect(rowLocator(page, "not_reported").getByTestId("readout")).toHaveText(
        "Not reported",
      );
      await expect(rowLocator(page, "tobacco_dealer").getByTestId("readout")).toHaveText(
        "Off, removed by override",
      );
      await expect(rowLocator(page, "fulfilment_model").getByTestId("readout")).toContainText(
        "Ship by carrier · Set for this business",
      );
      // the row never shows the old chips
      await expect(rowLocator(page, "t1_style")).not.toContainText("dark");
    });

    test("BO-12: label and readout share one line; the actions sit under the description below lg", async ({
      page,
    }) => {
      await gotoConsole(page);
      const r = rowLocator(page, "tobacco_dealer");
      const label = await box(r.getByText("Regulated items (tobacco)"));
      const readout = await box(r.getByTestId("readout"));
      // one line: the readout's vertical centre sits inside the label's line box
      const centre = readout.y + readout.height / 2;
      expect(centre).toBeGreaterThan(label.y - 2);
      expect(centre).toBeLessThan(label.y + label.height + 2);
      const description = await box(
        r.getByText("Description of tobacco_dealer.", { exact: false }),
      );
      const details = await box(r.getByRole("button", { name: /^Details for/ }));
      if (vp.width < 1024) {
        // actions on their own line under the description, left aligned with the label
        expect(details.y).toBeGreaterThanOrEqual(description.y + description.height - 1);
        expect(Math.abs(details.x - label.x)).toBeLessThanOrEqual(8);
      }
    });

    test("BO-12: Details opens a full-width panel after the mode radios, with the release stage", async ({
      page,
    }) => {
      await gotoConsole(page);
      const r = rowLocator(page, "t1_style");
      const toggle = r.getByRole("button", { name: "Details for Row t1_style" });
      await toggle.focus();
      await toggle.press("Enter");
      const panel = page.locator("#why-panel-t1_style");
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(
        "Release stage: Beta. Released for testing and may still change.",
      );
      await expect(panel).toContainText("Not enforced yet. This check only logs a warning");
      // opening it does not move focus
      await expect(toggle).toBeFocused();
      // full width of the row's content box
      const rowBox = await box(r);
      const panelBox = await box(panel);
      expect(panelBox.width).toBeGreaterThan(rowBox.width - 48);
    });
  });
}
