/**
 * BO-05: "What this business does", the capability checkboxes on the Backoffice tenant Setup tab, proved at 1440, 768
 * and 390.
 *
 * NOT RUN by the author (no stack in the build worktree). Every API call is mocked (the same pattern as
 * bo-web-console.spec.ts and bo-web-readiness.spec.ts): the `business-capabilities` endpoints do not exist on the
 * server until fix/mb-bo-api lands, the tenant is a throwaway `qa-*` slug, and no live tenant is ever contacted. Auth
 * is a locally faked super-admin token the page only decodes client-side. The spec only PREVIEWS: a real write is
 * answered with a 500 and counted, and every test asserts the count stays at zero.
 *
 * `PLAYWRIGHT_BASE_URL` has no default: `baseUrl()` throws when it is unset, so a forgotten variable can never point
 * this spec at a real site.
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

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

const TENANT_ID = "qa-bo-capabilities-1";

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

const FLEET = ["recurring_routes", "order_delivery", "driver_payments"];

function preset(
  key: string,
  label: string,
  ticks: Record<string, boolean | string>,
  fleet: boolean,
  modes: Record<string, string>,
) {
  return {
    key,
    label,
    description: label,
    available: true,
    modes,
    grants: fleet ? FLEET : [],
    denies: fleet ? [] : FLEET,
    ticks: {
      delivery: false,
      doorPayments: false,
      shipping: false,
      counter: false,
      opensAs: "order",
      ...ticks,
    },
  };
}

const PRESETS = [
  preset(
    "delivery_distributor",
    "Delivery distributor",
    { delivery: true, doorPayments: true },
    true,
    {
      fulfilment_model: "delivery",
    },
  ),
  preset("shipping_wholesaler", "Shipping wholesaler", { shipping: true }, false, {
    fulfilment_model: "ship",
  }),
  preset("in_store_retailer", "Counter retailer", { counter: true }, false, {
    fulfilment_model: "pickup",
  }),
  preset(
    "in_store_shipping_retailer",
    "Counter + shipping retailer",
    { shipping: true, counter: true, opensAs: "counter" },
    false,
    { fulfilment_model: "pickup_ship" },
  ),
  preset(
    "delivery_pos",
    "Delivery + counter",
    { delivery: true, doorPayments: true, counter: true },
    true,
    { fulfilment_model: "delivery" },
  ),
  preset(
    "delivery_shipping",
    "Delivery + shipping",
    { delivery: true, doorPayments: true, shipping: true },
    true,
    { fulfilment_model: "both" },
  ),
  preset(
    "delivery_shipping_pos",
    "Everything",
    { delivery: true, doorPayments: true, shipping: true, counter: true },
    true,
    { fulfilment_model: "both" },
  ),
];

/** Saved: Delivery with door payments (the "Delivery" preset). */
const SAVED = {
  configured: true,
  delivery: true,
  doorPayments: true,
  shipping: false,
  counter: false,
  opensAs: "order",
  opensAsChoosable: false,
  counterCapability: "off",
  fleetHeld: true,
  matchedPreset: "delivery_distributor",
};

/** Ticking Shipping on top of the saved Delivery: a mode change, nothing billed. */
const PREVIEW = {
  plan: {
    overrides: [],
    comps: [],
    modes: [{ key: "fulfilment_model", from: "delivery", to: "both" }],
    billing: [],
  },
  summary: ["Where orders go: Own delivery → Delivery and shipping"],
  changes: ["Where orders go: Own delivery → Delivery and shipping"],
  planFingerprint: "f".repeat(64),
  before: [],
  after: [],
  changed: [],
  blocked: null,
};

/** Mocks the tenant shell and the capabilities endpoints; returns what the page tried to WRITE. */
async function gotoSetup(page: Page): Promise<{ writes: string[] }> {
  const writes: string[] = [];
  const tenant = `/platform-admin/tenants/${TENANT_ID}`;
  await page.addInitScript((token) => {
    window.localStorage.setItem("superAdminToken", token);
  }, fakeSuperAdminToken());
  // Registered first, so every route below wins: nothing the page reads can reach the real API (a 401 there wipes
  // the fake token and redirects to /admin-login).
  await mockUnmockedBackoffice(page);
  await mockOverviewReads(page, TENANT_ID, {
    fulfilment_model: "delivery",
    counter_sales: "unset",
  });
  await page.route(new RegExp(`${tenant}$`), (route) =>
    fulfillJson(route, {
      id: TENANT_ID,
      slug: "qa-bo-capabilities",
      name: "QA Backoffice Capabilities Tenant",
      status: "ACTIVE",
      plan: "BUSINESS",
      planKey: "SCALE",
      trialEndsAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      businessName: "QA Backoffice Capabilities Tenant",
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
  await page.route(new RegExp(`${tenant}/admin(\\?.*)?$`), (route) =>
    fulfillJson(route, { admin: null }),
  );
  await page.route(new RegExp(`${tenant}/addons(\\?.*)?$`), (route) => fulfillJson(route, []));
  await page.route(new RegExp(`${tenant}/feature-overrides$`), (route) => fulfillJson(route, []));
  await page.route(/\/platform-admin\/audit-logs(\?.*)?$/, (route) =>
    fulfillJson(route, { data: [], meta: { total: 0, pages: 1 } }),
  );
  await page.route(/\/platform-admin\/features\/registry(\?.*)?$/, (route) =>
    fulfillJson(route, []),
  );
  await page.route(new RegExp(`${tenant}/features/effective(\\?.*)?$`), (route) =>
    fulfillJson(route, { effective: [] }),
  );
  await page.route(/\/platform-admin\/features\/diffs(\?.*)?$/, (route) => fulfillJson(route, []));
  await page.route(/\/platform-admin\/entitlements\/mode(\?.*)?$/, (route) =>
    fulfillJson(route, { mode: "shadow" }),
  );
  await page.route(new RegExp(`${tenant}/feature-config/[a-z_]+$`), (route) =>
    fulfillJson(route, { value: "delivery" }),
  );
  await page.route(/\/platform-admin\/business-profiles(\?.*)?$/, (route) =>
    fulfillJson(route, { profiles: PRESETS, availability: {} }),
  );
  await page.route(new RegExp(`${tenant}/business-capabilities$`), (route) => {
    if (route.request().method() === "POST") {
      writes.push(`POST ${route.request().url()}`);
      return fulfillJson(route, { message: "blocked by the spec" }, 500);
    }
    return fulfillJson(route, SAVED);
  });
  await page.route(new RegExp(`${tenant}/business-capabilities/preview$`), (route) =>
    fulfillJson(route, PREVIEW),
  );

  await page.goto(`/admin/tenants/${TENANT_ID}?tab=setup`);
  await expect(page.getByRole("group", { name: "What this business does" })).toBeVisible({
    timeout: 15_000,
  });
  return { writes };
}

const applyName = /^(Apply|Stop billing and apply)$/;
const FIELDSET = "fieldset[data-focus-target='capabilities']";

for (const size of WIDTHS) {
  test.describe(`BO-05 at ${size.width}`, () => {
    test.use({ viewport: size });

    test("every checkbox row, the Start from… button and each preset are at least 44 px tall, with no sideways scroll", async ({
      page,
    }) => {
      await gotoSetup(page);
      const rows = page.locator(`${FIELDSET} label:has(input[type=checkbox])`);
      expect(await rows.count()).toBe(4);
      for (let i = 0; i < 4; i++) {
        const box = await rows.nth(i).boundingBox();
        expect(box!.height, `checkbox row ${i}`).toBeGreaterThanOrEqual(44);
      }
      const start = page.getByRole("button", { name: "Start from…" });
      expect((await start.boundingBox())!.height).toBeGreaterThanOrEqual(44);

      await start.click();
      const items = page.getByRole("menuitem");
      expect(await items.count()).toBe(7);
      for (let i = 0; i < 7; i++) {
        expect((await items.nth(i).boundingBox())!.height, `preset ${i}`).toBeGreaterThanOrEqual(
          44,
        );
      }
      const menu = (await page.getByRole("menu").boundingBox())!;
      expect(menu.x + menu.width).toBeLessThanOrEqual(size.width + 1);
      await page.keyboard.press("Escape");

      const overflow = await page.evaluate(() => {
        const main = document.querySelector("main") as HTMLElement;
        return { scroll: main.scrollWidth, client: main.clientWidth };
      });
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
    });

    test("ticking Delivery + Shipping previews inline, fits, and writes nothing", async ({
      page,
    }) => {
      const { writes } = await gotoSetup(page);
      await page.getByRole("checkbox", { name: "Ships by carrier" }).check();

      const preview = page.getByTestId("capability-preview");
      await expect(preview).toBeVisible();
      await expect(preview).toHaveAttribute("aria-busy", "false", { timeout: 10_000 });
      await expect(preview).toContainText("Delivery and shipping");
      await expect(page.getByRole("button", { name: applyName })).toBeEnabled();

      // the preview fits the viewport, beside the controls at 1440 and stacked below them at 768 and 390
      const panel = (await preview.boundingBox())!;
      const fieldset = (await page.locator(FIELDSET).boundingBox())!;
      expect(panel.x + panel.width).toBeLessThanOrEqual(size.width + 1);
      if (size.width >= 1024)
        expect(panel.x).toBeGreaterThanOrEqual(fieldset.x + fieldset.width - 1);
      else expect(panel.y).toBeGreaterThanOrEqual(fieldset.y + fieldset.height - 1);

      // the actions are the full width of the card at 390
      if (size.width <= 390) {
        const apply = (await page.getByRole("button", { name: applyName }).boundingBox())!;
        expect(apply.width).toBeGreaterThan(size.width * 0.6);
      }

      // nothing was written: only the preview was asked for
      expect(writes).toEqual([]);
    });

    test("a nothing-ticked draft says why Apply is off", async ({ page }) => {
      const { writes } = await gotoSetup(page);
      for (const name of ["Delivers on own trucks", "Ships by carrier", "Sells at the counter"]) {
        const box = page.getByRole("checkbox", { name });
        if (await box.isChecked()) await box.uncheck();
      }
      await expect(page.getByText("Tick at least one.")).toBeVisible();
      await expect(page.getByRole("button", { name: applyName })).toBeDisabled();
      expect(writes).toHaveLength(0);
    });
  });
}
