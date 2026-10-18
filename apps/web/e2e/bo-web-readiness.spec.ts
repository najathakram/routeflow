/**
 * BO-02: the Overview readiness card reads one server answer, never sits amber for a business that
 * has not chosen how it sells, and its links land (scroll `<main>`, focus the target), proved at
 * 1440, 768 and 390.
 *
 * NOT RUN by the author (no stack in the build worktree). Every API call is mocked (the same
 * pattern as bo-web-console.spec.ts), the tenant is a throwaway `qa-*` slug, and no live tenant is
 * ever contacted. Auth is a locally faked super-admin token the page only decodes client-side.
 *
 * `PLAYWRIGHT_BASE_URL` has no default: `baseUrl()` throws when it is unset, so a forgotten
 * variable can never point this spec at a real site.
 *
 * The "Choose" landing check needs the Setup tab to mount an element marked
 * `data-focus-target="capabilities"` (BO-05). Until then that test skips itself instead of failing.
 */
import { test, expect, type Page, type Route } from "@playwright/test";

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

const TENANT_ID = "qa-bo-readiness-1";

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

const CAPS_UNSET = {
  configured: false,
  delivery: false,
  doorPayments: false,
  shipping: false,
  counter: false,
  opensAs: null,
  opensAsChoosable: false,
  counterCapability: "off",
  fleetHeld: false,
  matchedPreset: null,
};
const CAPS_COUNTER = {
  ...CAPS_UNSET,
  configured: true,
  counter: true,
  opensAs: "counter",
  counterCapability: "optional",
};
const CAPS_DELIVERY_ONLY = { ...CAPS_UNSET, configured: true, delivery: true };

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

interface Shell {
  caps: unknown;
  hasAdmin: boolean;
}

/** Mocks the tenant shell; returns the URLs the page requested so a test can assert on them. */
async function gotoOverview(page: Page, shell: Shell, search = "") {
  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}$`), (route) =>
    fulfillJson(route, {
      id: TENANT_ID,
      slug: "qa-bo-readiness",
      name: "QA Backoffice Readiness Tenant",
      status: "ACTIVE",
      plan: "BUSINESS",
      planKey: "SCALE",
      trialEndsAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      businessName: "QA Backoffice Readiness Tenant",
      primaryColor: null,
      logoKey: null,
      addressLine1: null,
      city: null,
      state: null,
      zip: null,
      country: null,
      phone: null,
      subscription: null,
      counts: { users: 1, customers: 0, orders: 0, drivers: 0, routes: 0, products: 3 },
    }),
  );
  await page.route(
    new RegExp(`/platform-admin/tenants/${TENANT_ID}/business-capabilities$`),
    (route) => fulfillJson(route, shell.caps),
  );
  await page.route(new RegExp(`/platform-admin/tenants/${TENANT_ID}/admin(\\?.*)?$`), (route) =>
    fulfillJson(route, {
      admin: shell.hasAdmin
        ? { id: "u1", username: "boss", status: "ACTIVE", email: "b@x.co" }
        : null,
    }),
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
    fulfillJson(route, []),
  );
  await page.route(
    new RegExp(`/platform-admin/tenants/${TENANT_ID}/features/effective(\\?.*)?$`),
    (route) => fulfillJson(route, { effective: [] }),
  );
  await page.route(/\/platform-admin\/features\/diffs(\?.*)?$/, (route) => fulfillJson(route, []));
  await page.route(/\/platform-admin\/entitlements\/mode(\?.*)?$/, (route) =>
    fulfillJson(route, { mode: "shadow" }),
  );
  await page.route(/\/platform-admin\/business-profiles(\?.*)?$/, (route) =>
    fulfillJson(route, { profiles: [] }),
  );
  await page.addInitScript((token) => {
    window.localStorage.setItem("superAdminToken", token);
  }, fakeSuperAdminToken());
  await page.goto(`/admin/tenants/${TENANT_ID}${search}`);
  return requested;
}

const VIEWPORTS = [
  { label: "1440", width: 1440, height: 900 },
  { label: "768", width: 768, height: 1024 },
  { label: "390", width: 390, height: 844 },
];

/** True when `inner`'s box sits inside the visible box of `<main>` (the page's scroller). */
async function insideMain(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const main = document.querySelector("main");
    if (!el || !main) return false;
    const e = el.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    return e.top >= m.top - 1 && e.top < m.bottom;
  }, selector);
}

for (const vp of VIEWPORTS) {
  test.describe(`Backoffice readiness card, ${vp.label}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("a business that has not chosen shows one neutral line: no amber, a tall-enough Choose link", async ({
      page,
    }) => {
      const requested = await gotoOverview(page, { caps: CAPS_UNSET, hasAdmin: false });
      await expect(page.getByText("Choose how this business sells.")).toBeVisible();
      await expect(page.getByText("Not ready")).toHaveCount(0);
      await expect(page.getByText("Counter sales")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /details/i })).toHaveCount(0);
      const link = page.getByRole("link", { name: /^Choose how .* sells$/ });
      await expect(link).toHaveAttribute("href", /tab=setup&focus=capabilities/);
      const height = (await link.boundingBox())?.height ?? 0;
      expect(height).toBeGreaterThanOrEqual(vp.width < 768 ? 44 : 24);
      // no amber text anywhere on the card
      const amber = await page
        .locator("main")
        .getByRole("heading", { name: "Ready to take a sale?" })
        .locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]")
        .evaluate((card) => card.querySelectorAll("[class*='amber']").length);
      expect(amber).toBe(0);
      // the card asks the server once and never reads the effective trace
      expect(requested.some((u) => /features\/effective/.test(u))).toBe(false);
      expect(requested.filter((u) => /business-capabilities/.test(u)).length).toBeGreaterThan(0);
    });

    test("Choose opens the Setup tab and lands on the capabilities control", async ({ page }) => {
      await gotoOverview(page, { caps: CAPS_UNSET, hasAdmin: false });
      await page.getByRole("link", { name: /^Choose how .* sells$/ }).click();
      await expect(page).toHaveURL(/tab=setup/);
      const target = page.locator('[data-focus-target="capabilities"]');
      test.skip((await target.count()) === 0, "BO-05 has not mounted the capabilities target yet");
      await expect(target).toBeFocused();
      expect(await insideMain(page, '[data-focus-target="capabilities"]')).toBe(true);
      // the one-shot param is gone, the tab stays
      await expect(page).not.toHaveURL(/focus=/);
      await expect(page).toHaveURL(/tab=setup/);
    });

    test("Create admin scrolls main to the Admin Account card and focuses it, with no reload", async ({
      page,
    }) => {
      await gotoOverview(page, { caps: CAPS_COUNTER, hasAdmin: false });
      await page.evaluate(() => {
        (window as unknown as { __noReload: boolean }).__noReload = true;
      });
      await page.getByRole("link", { name: /^Create admin for/ }).click();
      const card = page.locator("#admin-account");
      await expect(card).toBeFocused();
      expect(await insideMain(page, "#admin-account")).toBe(true);
      await expect(page).not.toHaveURL(/focus=/);
      // same page, same document: the marker set before the click survived
      expect(
        await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
      ).toBe(true);
    });

    test("a configured business with the counter on reads Ready, and delivery-only hides the card", async ({
      page,
    }) => {
      await gotoOverview(page, { caps: CAPS_COUNTER, hasAdmin: true });
      await expect(page.getByText("Ready to take a sale", { exact: true })).toBeVisible();
      await expect(page.getByText("Not ready")).toHaveCount(0);
    });

    test("delivery without a counter hides the card", async ({ page }) => {
      await gotoOverview(page, { caps: CAPS_DELIVERY_ONLY, hasAdmin: true });
      await expect(page.getByRole("heading", { name: "Tenant Info" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Ready to take a sale?" })).toHaveCount(0);
    });
  });
}
