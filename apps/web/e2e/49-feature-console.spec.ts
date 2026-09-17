/**
 * Feature grants v2 (PR-2) — the data-driven Feature Console inside the platform-admin tenant
 * detail page's "Addons & Features" tab (/admin/tenants/[id]). Every endpoint is MOCKED (same
 * pattern as apps/web/e2e/48-feature-overrides.spec.ts's mockTenantShell/fulfillJson) — brief
 * A's real endpoints exist now (schema + contract landed), but this suite still mocks them so it
 * runs standalone against `npm run dev -w apps/web` without a live DB; it becomes a real-backend
 * regression pass once briefs B/C's services are wired end-to-end (see brief D's done-checklist:
 * "e2e mocked and then real after A"). Auth is faked the same way 48 does — SuperAdminGuard only
 * decodes the JWT payload locally, no server round-trip.
 */
import { test, expect, type Page, type Route } from "@playwright/test";

const TENANT_ID = "e2e-fc-tenant-1";

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

function tenantFixture() {
  return {
    id: TENANT_ID,
    slug: "e2e-fc-tenant",
    name: "E2E Feature Console Tenant",
    status: "ACTIVE",
    plan: "GROWTH",
    trialEndsAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    businessName: "E2E Feature Console Tenant",
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

// Mirrors app/(platform-admin)/.../tenants/[id]/_features/__fixtures__/registry.fixtures.ts —
// 3 areas × 6 keys, one `config` key (route_optimization, with a blocked "scheduled" mode and a
// "mixed" effective value), one internal key (developer_mode). `via` (flat) is included
// alongside `gate` so this single mock satisfies BOTH the console's registry fetch (reads
// `gate.via`/`gate.state`) and #795's overrides-drawer registry fetch (reads flat `via`).
const REGISTRY_FIXTURE = [
  {
    key: "tobacco_dealer",
    kind: "boolean",
    area: "compliance",
    label: "Regulated items (tobacco)",
    description: "License-column ledgers, monthly tobacco reports, regulated filings.",
    lifecycle: "ga",
    internal: false,
    gate: { via: "RequireAddon", state: "enforced" },
    via: "RequireAddon",
    billing: { skus: ["tobacco_dealer"] },
  },
  {
    key: "msrp",
    kind: "boolean",
    area: "compliance",
    label: "MSRP on invoices",
    description: "Suggested retail price (per piece) on products, customers, and invoices.",
    lifecycle: "ga",
    internal: false,
    gate: { via: "service", state: "enforced" },
    via: "service",
    billing: { skus: ["msrp"] },
  },
  {
    key: "recurring_routes",
    kind: "boolean",
    area: "routes",
    label: "Recurring routes",
    description: "Standing route templates and scheduled dispatch.",
    lifecycle: "ga",
    internal: false,
    gate: { via: "RequireAddon", state: "enforced" },
    via: "RequireAddon",
    billing: { skus: ["recurring_routes"] },
  },
  {
    key: "route_optimization",
    kind: "boolean",
    area: "routes",
    label: "Route optimization mode",
    description: "How dispatch chooses stop order for this tenant's routes.",
    lifecycle: "beta",
    internal: false,
    gate: { via: "RequirePlanFlag", state: "dark" },
    via: "RequirePlanFlag",
    billing: { skus: [] },
    config: {
      fallbackMode: "manual",
      modes: [
        { key: "manual", label: "Manual dispatch", lifecycle: "ga" },
        {
          key: "scheduled",
          label: "Scheduled dispatch",
          lifecycle: "beta",
          requires: ["route_scheduling_addon"],
        },
        { key: "mixed", label: "Both", lifecycle: "ga" },
      ],
    },
  },
  {
    key: "developer_mode",
    kind: "boolean",
    area: "platform",
    label: "Developer mode",
    description: "Unlocks in-development surfaces (mobile driver-app preview, dispatch API).",
    lifecycle: "beta",
    internal: true,
    gate: { via: "RequireAddon", state: "dark" },
    via: "RequireAddon",
    billing: { skus: [] },
  },
  {
    key: "boxes_pieces_mode",
    kind: "boolean",
    area: "platform",
    label: "Boxes & pieces display",
    description: "Whether order/invoice line quantities show boxes, pieces, or both.",
    lifecycle: "ga",
    internal: false,
    gate: { via: "guard", state: "enforced" },
    via: "guard",
    billing: { skus: [] },
  },
];

const PLAN_KEY = "GROWTH";
const CATALOG_VERSION_ID = "catalog-v11";

interface MockEffectiveFeature {
  key: string;
  area: string;
  serving: boolean;
  resolver: boolean;
  source: string;
  detail: Record<string, unknown>;
  billing: Record<string, unknown>;
  mode?: { value: string; effective: string; source: string; allowed: string[]; blocked: string[] };
}

function baseFeature(
  key: string,
  area: string,
  overrides: Partial<MockEffectiveFeature> = {},
): MockEffectiveFeature {
  return {
    key,
    area,
    serving: false,
    resolver: false,
    source: "NONE",
    detail: { planKey: PLAN_KEY, catalogVersionId: CATALOG_VERSION_ID, enforced: true },
    billing: { charged: false },
    ...overrides,
  };
}

const EFFECTIVE_FIXTURE = [
  baseFeature("tobacco_dealer", "compliance", {
    serving: false,
    source: "OVERRIDE_DENY",
    detail: {
      overrideId: "ov-1",
      reason: "Client requested removal during a compliance review.",
      planKey: PLAN_KEY,
      catalogVersionId: CATALOG_VERSION_ID,
      enforced: true,
    },
  }),
  baseFeature("msrp", "compliance", {
    serving: true,
    source: "OVERRIDE_GRANT",
    detail: {
      overrideId: "ov-2",
      reason: "Grandfathered from the legacy MSRP pilot cohort.",
      kind: "GRANDFATHER",
      planKey: PLAN_KEY,
      catalogVersionId: CATALOG_VERSION_ID,
      enforced: true,
    },
  }),
  baseFeature("recurring_routes", "routes", {
    serving: true,
    source: "ADDON_SKU",
    detail: {
      sku: "recurring_routes",
      planKey: PLAN_KEY,
      catalogVersionId: CATALOG_VERSION_ID,
      enforced: true,
    },
    billing: { charged: true, sku: "recurring_routes" },
  }),
  baseFeature("route_optimization", "routes", {
    serving: true,
    source: "PRESET",
    detail: {
      term: "default",
      planKey: PLAN_KEY,
      catalogVersionId: CATALOG_VERSION_ID,
      enforced: false,
    },
    mode: {
      value: "mixed",
      effective: "mixed",
      source: "TENANT",
      allowed: ["manual", "mixed"],
      blocked: ["scheduled"],
    },
  }),
  baseFeature("developer_mode", "platform", {
    serving: true,
    source: "OVERRIDE_GRANT",
    detail: {
      overrideId: "ov-3",
      reason: "Piloting the mobile driver-app preview.",
      kind: "PILOT",
      planKey: PLAN_KEY,
      catalogVersionId: CATALOG_VERSION_ID,
      enforced: false,
    },
  }),
  baseFeature("boxes_pieces_mode", "platform"),
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

/** Installs mocks for every endpoint the tenant page's Overview + Addons tabs touch. */
async function mockTenantShell(page: Page, opts: { registryStatus?: number } = {}) {
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}$`), (route) =>
    fulfillJson(route, tenantFixture()),
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
    opts.registryStatus
      ? fulfillJson(route, { message: "Internal error" }, opts.registryStatus)
      : fulfillJson(route, REGISTRY_FIXTURE),
  );
  await page.route(
    new RegExp(`/platform-admin/tenants/${TENANT_ID}/features/effective(\\?.*)?$`),
    (route) => fulfillJson(route, EFFECTIVE_FIXTURE),
  );
  await page.route(/\/platform-admin\/features\/diffs(\?.*)?$/, (route) => fulfillJson(route, []));
  await page.route(/\/platform-admin\/entitlements\/mode(\?.*)?$/, (route) =>
    fulfillJson(route, { mode: "shadow" }),
  );
  // Pure function of the request body — before/after/changed, writes nothing.
  await page.route(
    new RegExp(`/platform-admin/tenants/${TENANT_ID}/features/preview$`),
    (route) => {
      const req = route.request().postDataJSON() as {
        planKey?: string;
        overrides?: { featureKey: string; effect: "GRANT" | "DENY" }[];
        modes?: Record<string, string>;
      };
      const changed: string[] = [];
      const after = EFFECTIVE_FIXTURE.map((f) => {
        if (req.planKey === "STARTER" && f.key === "recurring_routes") {
          changed.push(f.key);
          return { ...f, serving: false, source: "NONE", billing: { charged: false } };
        }
        for (const ov of req.overrides ?? []) {
          if (ov.featureKey === f.key) {
            changed.push(f.key);
            return {
              ...f,
              serving: ov.effect === "GRANT",
              source: ov.effect === "GRANT" ? "OVERRIDE_GRANT" : "OVERRIDE_DENY",
            };
          }
        }
        for (const [key, mode] of Object.entries(req.modes ?? {})) {
          if (f.key === key && f.mode) {
            changed.push(f.key);
            return { ...f, mode: { ...f.mode, value: mode, effective: mode } };
          }
        }
        return f;
      });
      return fulfillJson(route, { before: EFFECTIVE_FIXTURE, after, changed });
    },
  );
  // Brief C's endpoint — mocked (TODO(C) in lib/platform-admin/features.ts).
  await page.route(
    new RegExp(`/platform-admin/tenants/${TENANT_ID}/feature-config/[^/]+$`),
    (route) =>
      fulfillJson(route, {
        key: "route_optimization",
        mode: {
          value: "manual",
          effective: "manual",
          source: "TENANT",
          allowed: ["manual"],
          blocked: ["scheduled"],
        },
      }),
  );
}

async function gotoFeatureConsole(page: Page) {
  await page.addInitScript((token) => {
    window.localStorage.setItem("superAdminToken", token);
  }, fakeSuperAdminToken());
  await page.goto(`/admin/tenants/${TENANT_ID}`);
  await page.getByRole("button", { name: "Addons & Features" }).click();
  // NOT getByText("compliance") — the legacy AVAILABLE_ADDONS card "Regulated compliance pack"
  // (name + description) also contains that substring, a strict-mode collision. The console's
  // own area heading is an exact-text <h3>, unique from that card's copy.
  await expect(page.getByRole("heading", { name: "compliance", exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

const VIEWPORTS = [
  { label: "1440", width: 1440, height: 900 },
  { label: "768", width: 768, height: 1024 },
  { label: "390", width: 390, height: 844 },
];

for (const vp of VIEWPORTS) {
  test.describe(`Feature console — ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`${vp.label}px — empty registry shows the empty state, never a blank tab`, async ({
      page,
    }) => {
      await mockTenantShell(page);
      await page.route(/\/platform-admin\/features\/registry(\?.*)?$/, (route) =>
        fulfillJson(route, []),
      );
      await page.addInitScript((token) => {
        window.localStorage.setItem("superAdminToken", token);
      }, fakeSuperAdminToken());
      await page.goto(`/admin/tenants/${TENANT_ID}`);
      await page.getByRole("button", { name: "Addons & Features" }).click();
      await expect(page.getByText("No features are registered yet.")).toBeVisible();
    });

    test(`${vp.label}px — populated: all six badges render`, async ({ page }) => {
      await mockTenantShell(page);
      await gotoFeatureConsole(page);

      await expect(page.locator('[data-feature-key="tobacco_dealer"]')).toContainText("Removed");
      await expect(page.locator('[data-feature-key="msrp"]')).toContainText("Grandfathered");
      await expect(page.locator('[data-feature-key="recurring_routes"]')).toContainText(
        "Purchased",
      );
      await expect(page.locator('[data-feature-key="route_optimization"]')).toContainText(
        "Inherited",
      );
      await expect(page.locator('[data-feature-key="boxes_pieces_mode"]')).toContainText("Off");

      await page.getByLabel("Show internal").check();
      await expect(page.locator('[data-feature-key="developer_mode"]')).toContainText("Added");
    });

    test(`${vp.label}px — blocked mode option is disabled with the missing key named`, async ({
      page,
    }) => {
      await mockTenantShell(page);
      await gotoFeatureConsole(page);

      const row = page.locator('[data-feature-key="route_optimization"]');
      await expect(row.getByText("Both")).toBeVisible();
      const scheduled = row.getByRole("radio", { name: "Scheduled dispatch" });
      await expect(scheduled).toBeDisabled();
      await expect(scheduled.locator("xpath=..")).toHaveAttribute(
        "title",
        /route_scheduling_addon/,
      );
    });

    test(`${vp.label}px — tier change preview → confirm`, async ({ page }) => {
      await mockTenantShell(page);
      await gotoFeatureConsole(page);

      await page.getByLabel("Tier").selectOption("STARTER");
      await page.getByRole("button", { name: "Preview tier change" }).click();
      await expect(page.getByRole("heading", { name: "Preview tier change" })).toBeVisible();
      await expect(page.getByTestId("preview-diff")).toContainText("Recurring routes");
      // Confirm calls the page's existing plan-change action — no separate write endpoint here.
      await page.getByRole("button", { name: "Confirm" }).click();
      await expect(page.getByRole("heading", { name: "Preview tier change" })).not.toBeVisible();
    });

    test(`${vp.label}px — registry fetch failure shows the error alert, never a blank tab`, async ({
      page,
    }) => {
      await mockTenantShell(page, { registryStatus: 500 });
      await page.addInitScript((token) => {
        window.localStorage.setItem("superAdminToken", token);
      }, fakeSuperAdminToken());
      await page.goto(`/admin/tenants/${TENANT_ID}`);
      await page.getByRole("button", { name: "Addons & Features" }).click();
      await expect(page.getByText("Could not load the feature console. Try again.")).toBeVisible();
    });
  });
}
