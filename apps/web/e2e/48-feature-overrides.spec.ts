/**
 * Feature grants PR-1 — the Overrides section on the platform-admin tenant detail page's
 * Addons & Features tab (/admin/tenants/[id]). Every endpoint the page touches to reach that
 * tab is MOCKED (same pattern as 09-regulated-compliance.spec.ts's mockRegulatedApi). Auth is
 * ALSO faked client-side: (platform-admin)/layout.tsx's SuperAdminGuard only decodes the JWT
 * payload and checks role/exp locally (no server round-trip to verify the signature), so
 * fakeSuperAdminToken() below satisfies it without any real login, live API, or DB — the whole
 * suite runs against a bare `npm run dev -w apps/web` (no PLAYWRIGHT_SA_* creds needed, unlike
 * 01-super-admin.spec.ts/47-house-tenant-mrr-verify.spec.ts, which do a real login).
 *
 * Proof required by owner ruling (2026-09-15, Playwright proof for all UI): a screenshot per
 * state at each of 1440/768/390, for independent visual review before merge — saved to
 * local-assets/feature-overrides-2026-09-16/ (gitignored machine-local home for generated
 * screenshots, per CLAUDE.md's Heavy files policy).
 */
import { test, expect, type Page, type Route } from "@playwright/test";

const TENANT_ID = "e2e-fo-tenant-1";

function base64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** An unsigned-but-well-formed JWT: SuperAdminGuard decodes the payload, never verifies the signature. */
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
    via: "RequireAddon",
  },
  {
    key: "recurring_routes",
    label: "Recurring routes",
    area: "routes",
    kind: "boolean",
    internal: false,
    via: "RequireAddon",
  },
  {
    key: "developer_mode",
    label: "Developer mode",
    area: "platform",
    kind: "boolean",
    internal: true,
    via: "RequireAddon",
  },
  {
    key: "flag.credit_limits",
    label: "Customer credit limits",
    area: "finance",
    kind: "boolean",
    internal: false,
    via: "service",
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

function effectiveFeatureStub(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    area: "misc",
    serving: false,
    resolver: false,
    source: "NONE",
    detail: { planKey: "GROWTH", catalogVersionId: "catalog-v11", enforced: true },
    billing: { charged: false },
    ...overrides,
  };
}

/** Mocks `POST .../tenants/:id/features/preview` — owner rule (2026-09-17): EVERY override
 * write previews first, so every interactive test below needs this before it can reach Confirm. */
async function mockOverridePreview(page: Page, featureKey: string) {
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}/features/preview$`), (route) =>
    fulfillJson(route, {
      before: [effectiveFeatureStub(featureKey)],
      after: [effectiveFeatureStub(featureKey, { serving: true, source: "OVERRIDE_GRANT" })],
      changed: [featureKey],
    }),
  );
}

async function gotoOverridesSection(page: Page) {
  // Runs before any page script on every navigation this context makes, so the guard's
  // useEffect sees the token on first paint — no real login, no live API.
  await page.addInitScript((token) => {
    window.localStorage.setItem("superAdminToken", token);
  }, fakeSuperAdminToken());
  await page.goto(`/admin/tenants/${TENANT_ID}`);
  await page.getByRole("button", { name: "Addons & Features" }).click();
  // NOT `getByRole("heading", {name: "Overrides"})` — the tenant fixture's own name ("E2E
  // Feature Overrides Tenant") contains that substring too, via the page's <h1>, so an
  // unqualified substring match on "Overrides" is satisfied by that H1 alone and never
  // actually proves this section rendered. "+ New Override" is unique to this section.
  await expect(page.getByRole("button", { name: "+ New Override" })).toBeVisible({
    timeout: 15_000,
  });
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
      // Not getByText("tobacco_dealer") — the addon card's own description also mentions
      // it ("legacy key: tobacco_dealer"), a strict-mode-ambiguous match. The table cell is unique.
      await expect(page.getByRole("cell", { name: "tobacco_dealer" })).toBeVisible();
      await expect(page.getByText("GRANT")).toBeVisible();
      // exact: true — getByText is case-insensitive by default, and the tenant header's own
      // "ACTIVE" status badge would otherwise strict-mode-collide with this row's "Active".
      await expect(page.getByText("Active", { exact: true })).toBeVisible();
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
        // <main> is its own overflow-y-auto scroll container (not the body), so
        // page.screenshot({fullPage: true}) has nothing extra to capture — the addon-card grid
        // above pushes this section below the fold at 768px without this. Scroll it into view
        // so every screenshot actually shows what it's meant to prove, at every viewport.
        await page.getByRole("button", { name: "+ New Override" }).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `../../local-assets/feature-overrides-2026-09-16/${vp.label}-${state.name}.png`,
        });
      });
    }
  });
}

// ─── Interactive flows (Opus review of 8130b204, item 8) — 1440px, one representative
// viewport; the form's LOGIC doesn't change by viewport (the 15 cases above already prove
// the responsive layout at all three). ────────────────────────────────────────────────────

async function openCreateForm(page: Page) {
  await page.getByRole("button", { name: "+ New Override" }).click();
  await expect(page.getByRole("heading", { name: "New Feature Override" })).toBeVisible();
}

/** Preview → confirm, the ONE path every override write takes now (owner rule, 2026-09-17):
 * clicks "Preview Override" (opens the drawer, calling `POST .../features/preview` first), then
 * "Confirm" (the actual `POST .../feature-overrides`, mocked separately by the caller). */
async function previewAndConfirm(page: Page) {
  await page.getByRole("button", { name: "Preview Override" }).click();
  await expect(page.getByRole("heading", { name: "Preview override" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm" }).click();
}

async function fillCreateForm(page: Page, opts: { featureKey: string; reason: string }) {
  await page.getByLabel("Feature Key").selectOption(opts.featureKey);
  await page.getByLabel("Reason").fill(opts.reason);
}

test.describe("Feature overrides — interactive flows (1440px)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("create-modal success: submits, closes, and the new row appears", async ({ page }) => {
    await mockTenantShell(page);
    // A boolean flag, not a call-count — Next.js dev mode's React Strict Mode double-invokes
    // effects, so the GET can legitimately fire more than once before the POST; keying off
    // "has the create happened yet" (rather than "which numbered call is this") stays correct
    // regardless of how many times the pre-create GET repeats.
    let created = false;
    await page.route(
      new RegExp(`/platform-admin/tenants/${TENANT_ID}/feature-overrides$`),
      (route) => {
        if (route.request().method() === "POST") {
          created = true;
          return fulfillJson(route, overrideRow({ effect: "GRANT" }), 201);
        }
        return fulfillJson(route, created ? [overrideRow({ effect: "GRANT" })] : []);
      },
    );
    await mockOverridePreview(page, "tobacco_dealer");
    await gotoOverridesSection(page);
    await expect(page.getByText("No active overrides.")).toBeVisible();

    await openCreateForm(page);
    await fillCreateForm(page, { featureKey: "tobacco_dealer", reason: "Pilot onboarding" });
    await previewAndConfirm(page);

    await expect(page.getByRole("heading", { name: "Preview override" })).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "New Feature Override" })).not.toBeVisible();
    await expect(page.getByRole("cell", { name: "tobacco_dealer" })).toBeVisible();
    await page.getByRole("cell", { name: "tobacco_dealer" }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "../../local-assets/feature-overrides-2026-09-16/1440-create-success.png",
    });
  });

  test("create-modal inline 409: stays open, shows the conflict message", async ({ page }) => {
    await mockTenantShell(page);
    await mockOverridesList(page, [overrideRow({ effect: "GRANT" })]);
    await page.route(
      new RegExp(`/platform-admin/tenants/${TENANT_ID}/feature-overrides$`),
      (route) => {
        if (route.request().method() === "POST") {
          return fulfillJson(
            route,
            { message: 'An active override already exists for "tobacco_dealer" on this tenant.' },
            409,
          );
        }
        return fulfillJson(route, [overrideRow({ effect: "GRANT" })]);
      },
    );
    await mockOverridePreview(page, "tobacco_dealer");
    await gotoOverridesSection(page);

    await openCreateForm(page);
    await fillCreateForm(page, { featureKey: "tobacco_dealer", reason: "Try again" });
    await previewAndConfirm(page);

    await expect(page.getByText(/already exists for "tobacco_dealer"/)).toBeVisible();
    // "still open" now means the PREVIEW drawer (the form hides behind it while previewing —
    // only one AdminModal is ever open at a time), not the original form.
    await expect(page.getByRole("heading", { name: "Preview override" })).toBeVisible();
    await page.screenshot({
      path: "../../local-assets/feature-overrides-2026-09-16/1440-create-409.png",
    });
  });

  test("create-modal inline 400: joins a class-validator array message into one line", async ({
    page,
  }) => {
    await mockTenantShell(page);
    await mockOverridesList(page, []);
    await page.route(
      new RegExp(`/platform-admin/tenants/${TENANT_ID}/feature-overrides$`),
      (route) => {
        if (route.request().method() === "POST") {
          return fulfillJson(
            route,
            {
              message: [
                "expiresAt must be in the future.",
                "reason must be longer than 3 characters",
              ],
            },
            400,
          );
        }
        return fulfillJson(route, []);
      },
    );
    await mockOverridePreview(page, "tobacco_dealer");
    await gotoOverridesSection(page);

    await openCreateForm(page);
    await fillCreateForm(page, { featureKey: "tobacco_dealer", reason: "x" });
    await previewAndConfirm(page);

    await expect(
      page.getByText("expiresAt must be in the future.; reason must be longer than 3 characters"),
    ).toBeVisible();
    await page.screenshot({
      path: "../../local-assets/feature-overrides-2026-09-16/1440-create-400.png",
    });
  });

  test("revoke: the row leaves the active list after a successful revoke", async ({ page }) => {
    await mockTenantShell(page);
    // A boolean flag, not a call-count — see the create-modal-success test's comment: Strict
    // Mode can double-fire the pre-action GET, which a counter reads as "the action already
    // happened" prematurely.
    let revoked = false;
    await page.route(
      new RegExp(`/platform-admin/tenants/${TENANT_ID}/feature-overrides$`),
      (route) => fulfillJson(route, revoked ? [] : [overrideRow({ effect: "GRANT" })]),
    );
    await page.route(
      new RegExp(`/platform-admin/tenants/${TENANT_ID}/feature-overrides/ov-e2e-1/revoke$`),
      (route) => {
        revoked = true;
        return fulfillJson(
          route,
          overrideRow({ effect: "GRANT", revokedAt: "2026-09-16T00:00:00.000Z" }),
        );
      },
    );
    await gotoOverridesSection(page);
    await expect(page.getByRole("cell", { name: "tobacco_dealer" })).toBeVisible();

    await page.getByRole("button", { name: "Revoke" }).click();

    await expect(page.getByText("No active overrides.")).toBeVisible();
    await page.getByRole("button", { name: "+ New Override" }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "../../local-assets/feature-overrides-2026-09-16/1440-revoke.png",
    });
  });

  // Opus review item 9: the DENY-disables-a-restriction polarity trap must be visible in the form.
  test("the credit_limits polarity warning shows when that key is selected", async ({ page }) => {
    await mockTenantShell(page);
    await mockOverridesList(page, []);
    await gotoOverridesSection(page);

    await openCreateForm(page);
    await page.getByLabel("Feature Key").selectOption("flag.credit_limits");

    await expect(page.getByText(/Polarity trap/)).toBeVisible();
    await page.screenshot({
      path: "../../local-assets/feature-overrides-2026-09-16/1440-credit-limits-warning.png",
    });
  });
});
