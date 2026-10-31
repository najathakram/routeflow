/**
 * SA-1067 M1 / P4 in a real browser: with the price history panel open at the counter, a scanner's digits and Enter use no
 * price (P1), and Down then Enter uses the newest row and closes the panel (P4). Jest cannot see where focus really lands:
 * AnchoredPopover focuses its own shell once placed, so the keys have to be handled there.
 *
 * LOCAL LANE ONLY, same guards as 72: the tenant is put on the in_store_shipping_retailer profile (counter on) and restored
 * row-for-row in afterAll. READ-ONLY otherwise: a customer and a product that already share order history are DISCOVERED over
 * the API (no names are written here), the panel is driven, and the sale is never completed. Needs `npm run local:sa`.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";
import { assertLocalFulfilmentTarget } from "../lib/local-fulfilment-guard";
import {
  applyBusinessProfile,
  localTarget,
  readApiCapability,
  restoreFulfilmentConfig,
  snapshotFulfilmentConfig,
  waitForApiCapability,
  type FulfilmentSnapshot,
} from "./helpers/local-fulfilment-profile";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1440", width: 1440, height: 900 },
] as const;
const target = () => localTarget(apiBase(BASE));

let before: FulfilmentSnapshot | null = null;
let capabilityBefore: unknown = null;
test.beforeAll(async () => {
  assertLocalFulfilmentTarget(target());
  assertTestTenant(TENANT_SLUG, "sa1067 price history keys");
  before = await snapshotFulfilmentConfig(target());
  capabilityBefore = await readApiCapability(target());
  await applyBusinessProfile(target(), before, "in_store_shipping_retailer");
});
test.afterAll(async () => {
  test.setTimeout(120_000);
  if (!before) return;
  expect(await restoreFulfilmentConfig(target(), before)).toBe(true);
  await waitForApiCapability(target(), capabilityBefore, 60_000);
});

/** A named customer and a sellable product that already have order history together, found by reading only. */
async function discoverPair(page: Page) {
  await page.goto("/orders");
  const token = await operatorAccessToken(page);
  const api = `${apiBase(page.url())}/api/v1`;
  const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
  const get = async (path: string, params?: Record<string, string>) => {
    const res = await page.request.get(`${api}${path}`, { headers, params });
    expect(res.ok(), `${path}: ${res.status()}`).toBeTruthy();
    return (await res.json()) as any;
  };
  const customers: any[] = ((await get("/customers", { limit: "50" })) as any)?.data ?? [];
  const products: any[] = ((await get("/products", { limit: "50" })) as any)?.data ?? [];
  const sellable = products.filter(
    (p) => p?.isActive !== false && /^[0-9A-Za-z-]{4,}$/.test(String(p?.sku ?? "")),
  );
  for (const c of customers.filter((x) => x?.isWalkIn !== true).slice(0, 12)) {
    for (const p of sellable.slice(0, 12)) {
      const h = await page.request.get(`${api}/customers/${c.id}/products/${p.id}/price-history`, {
        headers,
        params: { limit: "25" },
      });
      if (!h.ok()) continue;
      const rows: any[] = ((await h.json()) as any)?.rows ?? [];
      if (rows.length >= 1) return { customer: c, product: p, newest: rows };
    }
  }
  throw new Error("the test tenant has no customer with order history for a sellable product");
}

for (const vp of VIEWPORTS) {
  test(`P1/P4: the price history panel's keys reach its handler at the counter @ ${vp.name}`, async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await setTenantCookie(context, BASE);
    const { customer, product } = await discoverPair(page);

    await page.goto("/orders/counter-sale");
    const scanField = page.getByLabel("Scan or search items");
    await expect(scanField).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Find a customer").fill(String(customer.businessName).slice(0, 12));
    await page
      .getByRole("option", { name: String(customer.businessName) })
      .first()
      .click();
    await scanField.fill(String(product.sku));
    await scanField.press("Enter");
    await expect(page.getByRole("list", { name: "Items" }).getByRole("listitem")).toHaveCount(1, {
      timeout: 15_000,
    });

    await page.getByRole("button", { name: "Price history" }).first().click();
    const panel = page.getByRole("dialog", { name: "Price history" });
    await expect(panel).toBeVisible({ timeout: 15_000 });
    // where does focus really land? The shell or something inside it, never outside the panel
    await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    // P1: a scanner's digits and its Enter use no price and leave the panel open
    await page.keyboard.type("4011");
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();

    // P4: Down then Enter uses the newest row: the panel closes (a handler that is never reached leaves it open)
    await page.keyboard.press("ArrowDown");
    await expect(panel.locator('[aria-selected="true"]').first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveCount(0, { timeout: 5_000 });
  });
}
