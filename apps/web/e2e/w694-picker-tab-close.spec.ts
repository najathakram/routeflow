/**
 * W-694 — SearchableProductPicker must close its list when keyboard focus leaves the field
 * (Tab / Shift+Tab) and on an outside click; Escape closes it too.
 *
 * Why this exists: jsdom cannot see real focus-leave (it never moves focus on Tab), so the unit
 * tests cannot prove the list closes. This runs real Chromium with real keyboard + mouse events.
 *
 * Mocked API, no tenant touched: EVERY /api/v1 call is mocked via page.route and auth is faked with
 * a locally-minted unsigned JWT in localStorage, so nothing can reach any tenant or any backend.
 * Covers both consumers:
 *   (a) Orders list "Filter by product…"      (apps/web/app/(dashboard)/orders/page.tsx)
 *   (b) Draft vendor-bill line picker (Edit)  (apps/web/app/(dashboard)/vendor-bills/[id]/page.tsx)
 *
 * Runs as the `picker-tab-close` project of playwright.config.ts (no setup project dependency).
 * Needs SKIP_E2E_SEED=true (globalSetup would otherwise try to seed a DB) and PLAYWRIGHT_BASE_URL
 * pointing at a running `next dev` / built web:
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 SKIP_E2E_SEED=true \
 *     npx playwright test --project=picker-tab-close
 */
import { test, expect, type Locator, type Page, type Route } from "@playwright/test";

const SLUG = "e2e-routeflow"; // approved test tenant slug; only used as a label, nothing is sent anywhere real

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
const FAKE_JWT = [
  b64url({ alg: "none", typ: "JWT" }),
  b64url({
    sub: "u-w694",
    username: "w694-operator",
    role: "TENANT_ADMIN",
    status: "ACTIVE",
    forcePasswordChange: false,
    isAdmin: true,
    canActAsDriver: false,
    tenantSlug: SLUG,
    tenantId: "t-w694",
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
  }),
  "sig",
].join(".");

const PRODUCTS = [
  {
    id: "p-1",
    name: "Alpha Widget",
    sku: "ALPHA-1",
    unit: "each",
    isActive: true,
    kind: "STANDARD",
  },
  { id: "p-2", name: "Beta Gadget", sku: "BETA-2", unit: "each", isActive: true, kind: "STANDARD" },
  {
    id: "p-3",
    name: "Gamma Gizmo",
    sku: "GAMMA-3",
    unit: "each",
    isActive: true,
    kind: "STANDARD",
  },
];
const META = { total: 0, page: 1, limit: 20, totalPages: 0 };
const BILL = {
  id: "bill-w694",
  billNumber: "VB-W694",
  supplierId: "s-1",
  supplier: { id: "s-1", name: "Acme Supply" },
  status: "DRAFT",
  billDate: "2026-10-01T00:00:00.000Z",
  dueDate: "2026-10-31T00:00:00.000Z",
  totalOwed: 10,
  totalPaid: 0,
  notes: "",
  payments: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  items: [
    { id: "bi-1", description: "Custom line", qty: 1, unitCost: 10, packSize: null, lineTotal: 10 },
  ],
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockWorld(page: Page, unmocked: string[]) {
  await page.addInitScript(
    ([token, slug]) => {
      try {
        localStorage.setItem("rf:op:accessToken", token);
        localStorage.setItem("rf:op:refreshToken", token);
        document.cookie = "rf-op-auth=1; path=/; max-age=86400; samesite=lax";
        document.cookie = `tenant-slug=${slug}; path=/; max-age=86400; samesite=lax`;
      } catch {
        /* storage unavailable */
      }
    },
    [FAKE_JWT, SLUG],
  );
  // Catch-all FIRST (Playwright runs the most recently registered matching route first).
  await page.route(/\/api\/v1\//, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^.*\/api\/v1/, "");
    unmocked.push(`${req.method()} ${path}`);
    if (req.method() !== "GET") return json(route, {});
    return json(route, { data: [], meta: META });
  });
  await page.route(/\/api\/v1\/products(\?.*)?$/, (route) =>
    json(route, { data: PRODUCTS, meta: { ...META, total: 3, totalPages: 1 } }),
  );
  // CreateOrderModal (mounted on /orders) calls .map() on this one, so it must be a bare array.
  await page.route(/\/api\/v1\/tracked-categories(\?.*)?$/, (route) => json(route, []));
  await page.route(/\/api\/v1\/vendor-bills\/bill-w694(\?.*)?$/, (route) => json(route, BILL));
  await page.route(/\/api\/v1\/inventory\/suppliers(\?.*)?$/, (route) =>
    json(route, [{ id: "s-1", name: "Acme Supply" }]),
  );
  await page.route(/\/api\/v1\/auth\/(refresh|me)(\?.*)?$/, (route) =>
    json(route, { accessToken: FAKE_JWT, refreshToken: FAKE_JWT, user: { id: "u-w694" } }),
  );
}

interface Consumer {
  name: string;
  open: (page: Page) => Promise<void>;
  input: (page: Page) => Locator;
  /** An unrelated, non-focusable, non-list element to click away onto. */
  heading: (page: Page) => Locator;
}

const CONSUMERS: Consumer[] = [
  {
    name: "orders filter",
    open: async (page) => {
      await page.goto("/orders");
      await expect(page.getByPlaceholder("Filter by product…")).toBeVisible({ timeout: 90_000 });
    },
    input: (page) => page.getByPlaceholder("Filter by product…"),
    heading: (page) => page.getByRole("heading").first(),
  },
  {
    name: "vendor-bill line",
    open: async (page) => {
      await page.goto("/vendor-bills/bill-w694");
      await page.getByRole("button", { name: "Edit", exact: true }).click({ timeout: 90_000 });
      await expect(
        page.getByPlaceholder("Search products… (or leave as custom item)"),
      ).toBeVisible();
    },
    input: (page) => page.getByPlaceholder("Search products… (or leave as custom item)").first(),
    heading: (page) => page.getByRole("heading").first(),
  },
];

for (const c of CONSUMERS) {
  test.describe(`W-694 picker closes — ${c.name}`, () => {
    let unmocked: string[] = [];

    test.beforeEach(async ({ page }) => {
      unmocked = [];
      // Cold `next dev` compiles each route on first hit: allow for it (the shared config is 60 s / 30 s).
      test.setTimeout(120_000);
      page.setDefaultNavigationTimeout(90_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await mockWorld(page, unmocked);
      await c.open(page);
    });

    /** Focus the picker with a real click and prove its list (aria-controls target + rows) is open. */
    async function openList(page: Page) {
      const input = c.input(page);
      await input.click();
      await expect(input).toBeFocused();
      await expect
        .poll(() => input.getAttribute("aria-controls"), { timeout: 10_000 })
        .toBeTruthy();
      const listId = (await input.getAttribute("aria-controls"))!;
      const list = page.locator(`[id="${listId}"]`);
      await expect(list).toBeVisible();
      await expect(list.getByRole("option")).toHaveCount(3, { timeout: 10_000 }); // 3 mocked products
      return { input, list };
    }

    test("Tab closes the list", async ({ page }) => {
      const { input, list } = await openList(page);
      await page.keyboard.press("Tab");
      await expect(input).not.toBeFocused(); // focus really left the field
      await expect(list).toBeHidden({ timeout: 3_000 });
      await expect(input).not.toHaveAttribute("aria-controls", /.+/);
    });

    test("Shift+Tab closes the list", async ({ page }) => {
      const { input, list } = await openList(page);
      await page.keyboard.press("Shift+Tab");
      await expect(input).not.toBeFocused();
      await expect(list).toBeHidden({ timeout: 3_000 });
      await expect(input).not.toHaveAttribute("aria-controls", /.+/);
    });

    test("outside click closes the list", async ({ page }) => {
      const { input, list } = await openList(page);
      const box = await c.heading(page).boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.click(box!.x + 4, box!.y + box!.height / 2);
      await expect(list).toBeHidden({ timeout: 3_000 });
      await expect(input).not.toHaveAttribute("aria-controls", /.+/);
    });

    test("Escape closes the list", async ({ page }) => {
      const { input, list } = await openList(page);
      await page.keyboard.press("Escape");
      await expect(list).toBeHidden({ timeout: 3_000 });
      await expect(input).not.toHaveAttribute("aria-controls", /.+/);
    });

    test.afterEach(async ({}, testInfo) => {
      if (unmocked.length)
        testInfo.annotations.push({
          type: "catch-all-mocked",
          description: [...new Set(unmocked)].join(" | "),
        });
    });
  });
}
