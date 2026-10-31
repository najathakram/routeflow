/**
 * SA-1073 PR-2 (81): a dialog opened from a menu leaves the page working when it closes, on one copy of Radix's layer.
 *   F1, F2: catalog, select, Restrict…, Add to a rule or New rule, Esc, click the page.
 *   F3, F4: till with one line, avatar, Sign out or Drive mode, Keep selling, click the till, the line is still there.
 *   F5, F6: the same from the buyer portal link and a notification link. Red rows, a different bug from the copies:
 *     the menu never closes (SA-1073 A-3), so on one copy they read 1 open menu and body `pointer-events` `none`.
 *   F7: Sign out with an empty cart still signs out.
 *   R1: a reload keeps the till's cart, so the row the PR reports is checked here.
 * No jsdom row can prove this: the freeze is a real browser's body `pointer-events`, left by two copies of Radix's layer.
 *
 * LOCAL LANE ONLY, same guards as 71: the tenant is put on the in_store_shipping_retailer profile (counter on) via
 * helpers/local-fulfilment-profile.ts and restored row-for-row in afterAll. Nothing is sold and no rule is saved. The
 * product is DISCOVERED over the API. Needs `npm run local:sa`.
 */
import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { loginAsOperator, setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";
import {
  applyBusinessProfile,
  localTarget,
  readApiCapability,
  restoreFulfilmentConfig,
  snapshotFulfilmentConfig,
  type FulfilmentSnapshot,
  waitForApiCapability,
} from "./helpers/local-fulfilment-profile";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const target = () => localTarget(apiBase(BASE));

let before: FulfilmentSnapshot | null = null;
let capabilityBefore: unknown = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  before = await snapshotFulfilmentConfig(target());
  capabilityBefore = await readApiCapability(target());
  await applyBusinessProfile(target(), before, "in_store_shipping_retailer");
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  if (!before) return;
  const restored = await restoreFulfilmentConfig(target(), before);
  expect(restored, "the tenant's fulfilment config is back exactly as it was").toBe(true);
  await waitForApiCapability(target(), capabilityBefore, 60_000);
});

/** The freeze itself: the body refuses pointer events, so the click below would never land. */
async function pageTakesClicks(page: Page, control: Locator) {
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).pointerEvents))
    .not.toBe("none");
  await control.click({ timeout: 5_000 });
}

const openMenus = (page: Page) => page.locator('[role="menu"][data-state="open"]');

const focusInDialog = (page: Page) =>
  page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));

async function openTillWithOneLine(page: Page, context: BrowserContext) {
  await setTenantCookie(context, BASE);
  await page.goto("/orders");
  const token = await operatorAccessToken(page);
  const res = await page.request.get(`${apiBase(page.url())}/api/v1/products`, {
    headers: { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG },
    params: { limit: "50" },
  });
  const products: any[] = ((await res.json()) as any)?.data ?? [];
  const sku = products
    .filter((p) => p?.isActive !== false)
    .map((p) => String(p?.sku ?? ""))
    .find((s) => /^[0-9A-Za-z-]{4,}$/.test(s));
  expect(sku, "the tenant needs an active product with a SKU").toBeTruthy();

  await page.goto("/orders/counter-sale");
  const scan = page.getByLabel("Scan or search items");
  await expect(scan).toBeVisible({ timeout: 15_000 });
  await scan.fill(sku as string);
  await scan.press("Enter");
  const lines = page.getByRole("list", { name: "Items" }).getByRole("listitem");
  await expect(lines).toHaveCount(1, { timeout: 15_000 });
  return { scan, lines };
}

/** F4 only: Drive mode needs a driver-capable user and routes. Both are stubbed in the browser, and nothing is written. */
async function offerDriveMode(page: Page) {
  await page.addInitScript(() => {
    const parse = JSON.parse;
    JSON.parse = (text, reviver) => {
      const value = parse(text, reviver);
      return value?.sub && value?.exp ? { ...value, canActAsDriver: true } : value;
    };
  });
  await page.route("**/tenants/me/addons", async (route) => {
    const res = await route.fetch();
    const { addons = [] } = (await res.json()) as { addons?: string[] };
    await route.fulfill({ response: res, json: { addons: [...addons, "recurring_routes"] } });
  });
}

const notificationToSettings = (page: Page) =>
  page.addInitScript((slug) => {
    const n = {
      id: "w1062",
      type: "order_status",
      title: "Proof notification",
      description: "Opens the settings",
      timestamp: Date.now(),
      read: false,
      href: "/settings",
    };
    window.localStorage.setItem(`rf_notifications:${slug}`, JSON.stringify([n]));
  }, TENANT_SLUG);

async function keepSelling(page: Page, scan: Locator, lines: Locator) {
  const dialog = page.getByRole("dialog", { name: "Discard this sale?" });
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "Keep selling" }).click();
  await expect(dialog).toBeHidden();
  await expect(openMenus(page)).toHaveCount(0);
  await pageTakesClicks(page, scan);
  await expect(lines).toHaveCount(1);
}

test.describe("the catalog's Restrict menu", () => {
  for (const [row, item] of [
    ["F1", "Add to a rule…"],
    ["F2", /^New rule with /],
  ] as const) {
    test(`${row}: ${String(item)} opens with focus in the dialog and leaves the page working`, async ({
      page,
      context,
    }) => {
      await setTenantCookie(context, BASE);
      await page.goto("/products");
      await page.getByRole("button", { name: "Select", exact: true }).click();
      await page.getByRole("checkbox", { name: "Select all" }).check();
      await page.getByTestId("restrict-menu-open").click();
      await page.getByRole("menuitem", { name: item }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect.poll(() => focusInDialog(page)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();

      await pageTakesClicks(page, page.getByRole("button", { name: "Cancel", exact: true }));
      await expect(page.getByRole("button", { name: "Select", exact: true })).toBeVisible();
    });
  }
});

test.describe("the till's user menu with lines in the cart", () => {
  const openUserMenu = (page: Page) => page.getByRole("button", { name: "Open user menu" }).click();

  test("F3: Sign out, Keep selling, the till still works and the cart is kept", async ({
    page,
    context,
  }) => {
    const { scan, lines } = await openTillWithOneLine(page, context);
    await openUserMenu(page);
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await keepSelling(page, scan, lines);
  });

  test("F4: Drive mode, Keep selling, the till still works and the cart is kept", async ({
    page,
    context,
  }) => {
    await offerDriveMode(page);
    const { scan, lines } = await openTillWithOneLine(page, context);
    await openUserMenu(page);
    await page.getByRole("menuitem", { name: "Drive mode" }).click();
    await keepSelling(page, scan, lines);
  });

  test("F5: the buyer portal link, Keep selling, the till still works", async ({
    page,
    context,
  }) => {
    const { scan, lines } = await openTillWithOneLine(page, context);
    await openUserMenu(page);
    await page.getByRole("menuitem", { name: /buyer portal/i }).click();
    await expect.poll(() => focusInDialog(page)).toBe(true);
    await keepSelling(page, scan, lines);
  });

  test("F6: a notification link, Keep selling, the till still works", async ({ page, context }) => {
    await notificationToSettings(page);
    const { scan, lines } = await openTillWithOneLine(page, context);
    await page.getByRole("button", { name: /notifications$/i }).click();
    await page.getByRole("link", { name: /Proof notification/ }).click();
    await expect.poll(() => focusInDialog(page)).toBe(true);
    await keepSelling(page, scan, lines);
  });

  test("R1: a reload keeps the cart", async ({ page, context }) => {
    const { lines } = await openTillWithOneLine(page, context);
    await page.reload();
    await expect(lines).toHaveCount(1, { timeout: 15_000 });
  });
});

test.describe("F7: an empty cart", () => {
  // Its own session: signing out must not end the operator.json one the other projects share.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("F7: Sign out with an empty cart signs out", async ({ page, context }) => {
    await setTenantCookie(context, BASE);
    await loginAsOperator(page);
    await page.goto("/orders/counter-sale");
    await expect(page.getByLabel("Scan or search items")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Open user menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/, { timeout: 15_000 });
  });
});
