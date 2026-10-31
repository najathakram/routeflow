/**
 * SA-1067 M1 / P4 in a real browser, two doors on the price history panel at the counter. P1: a scanner's digits and Enter
 * use no price (the scan-focus listener sends them to the scan box and the panel stays open). P4: Down then Enter, straight
 * after the panel opens, uses the newest row and closes it. Jest cannot see where focus really lands: AnchoredPopover
 * focuses its own shell once placed, so the keys have to be handled there.
 *
 * LOCAL LANE ONLY, same guards as 72: the tenant is put on the in_store_shipping_retailer profile (counter on) and restored
 * row-for-row in afterAll. READ-ONLY otherwise: a customer and a product that already share order history are DISCOVERED over
 * the API (no names are written here), the panel is driven, and the sale is never completed. Needs `npm run local:sa`.
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
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

/** Customer picked, one item on the sale, the price history panel open with focus inside it. */
async function openPanel(page: Page, context: BrowserContext, vp: (typeof VIEWPORTS)[number]) {
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
  return { panel, scanField };
}

for (const vp of VIEWPORTS) {
  test(`P1: a scanner's digits and Enter with the panel open use no price and leave it open @ ${vp.name}`, async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const { panel } = await openPanel(page, context, vp);
    await page.keyboard.type("4011");
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();
    // that Enter chose no row
    await expect(panel.locator('tbody tr[aria-selected="true"]')).toHaveCount(0);
  });

  test(`P4: Down then Enter in the panel uses the newest row and closes it @ ${vp.name}`, async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const { panel } = await openPanel(page, context, vp);
    await page.keyboard.press("ArrowDown");
    await expect(panel.locator('tbody tr[aria-selected="true"]').first()).toBeVisible();
    await page.keyboard.press("Enter");
    // a handler that is never reached leaves the panel open
    await expect(panel).toHaveCount(0, { timeout: 5_000 });
  });
}

/**
 * The same panel opens from two other doors, and where focus lands depends on the door, so P4 is driven at each one.
 * BUILDER (the Create Order window on /orders): "Use this price" there sets the line's price in the open window.
 * ORDER DETAIL (Edit Items on an editable order): the price goes into the edit session; the edit is CANCELLED, never saved.
 * Nothing is written to the tenant: the builder may park a draft on close, which is deleted again below.
 */
const PRODUCT_SEARCH = "Search by name, SKU or scan barcode…";

/** An editable order whose customer has price history for one of its products (other than the order itself), found by reading. */
async function discoverEditableOrder(page: Page) {
  await page.goto("/orders");
  const token = await operatorAccessToken(page);
  const api = `${apiBase(page.url())}/api/v1`;
  const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
  const get = async (path: string, params?: Record<string, string>) => {
    const res = await page.request.get(`${api}${path}`, { headers, params });
    return res.ok() ? ((await res.json()) as any) : null;
  };
  const list = (await get("/orders", { limit: "50" })) as any;
  const orders: any[] = list?.data ?? list?.orders ?? [];
  for (const o of orders.filter((x) =>
    ["DRAFT", "PENDING", "CONFIRMED"].includes(String(x?.status)),
  )) {
    const full = await get(`/orders/${o.id}`);
    const customerId = full?.customerId ?? o.customerId;
    const items: any[] = full?.items ?? full?.lineItems ?? [];
    if (!customerId) continue;
    for (const li of items) {
      const productId = li?.productId ?? li?.product?.id;
      if (!productId) continue;
      const h = await get(`/customers/${customerId}/products/${productId}/price-history`, {
        limit: "25",
        excludeOrderId: String(o.id),
      });
      if ((h?.rows ?? []).length >= 1) {
        return {
          orderId: String(o.id),
          productName: String(li?.productName ?? li?.product?.name ?? ""),
        };
      }
    }
  }
  throw new Error("the test tenant has no editable order with a priced line that has history");
}

for (const vp of VIEWPORTS) {
  test(`P4 at the builder: Down then Enter in the panel closes it @ ${vp.name}`, async ({
    page,
    context,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await setTenantCookie(context, BASE);
    const parked: string[] = [];
    const pending: Array<Promise<void>> = [];
    page.on("response", (resp) => {
      if (resp.request().method() !== "POST" || !/\/api\/v1\/drafts(\?.*)?$/.test(resp.url()))
        return;
      pending.push(
        resp
          .json()
          .then((b: { id?: string }) => {
            if (resp.ok() && b?.id) parked.push(b.id);
          })
          .catch(() => {}),
      );
    });
    try {
      const { customer, product } = await discoverPair(page);
      await page.goto("/orders");
      await page
        .getByRole("button", { name: /new order/i })
        .first()
        .click();
      await expect(page.getByRole("heading", { name: "Create Order" })).toBeVisible({
        timeout: 10_000,
      });
      await page
        .getByPlaceholder("Search by business name…")
        .fill(String(customer.businessName).slice(0, 14));
      await page
        .locator('input[placeholder="Search by business name…"] ~ ul li button')
        .filter({ hasText: String(customer.businessName) })
        .first()
        .click({ timeout: 10_000 });
      await page.getByPlaceholder(PRODUCT_SEARCH).fill(String(product.sku));
      await page
        .locator(`input[placeholder="${PRODUCT_SEARCH}"] ~ ul > li > button`)
        .filter({ hasNotText: "Create new product" })
        .first()
        .click({ timeout: 10_000 });

      await page.getByRole("button", { name: "Price history" }).first().click({ timeout: 15_000 });
      const panel = page.getByRole("dialog", { name: "Price history" });
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => panel.evaluate((el) => el.contains(document.activeElement)))
        .toBe(true);
      await page.keyboard.press("ArrowDown");
      await expect(panel.locator('tbody tr[aria-selected="true"]').first()).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(panel).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await Promise.all(pending.splice(0));
      const token = await operatorAccessToken(page).catch(() => "");
      for (const id of parked.splice(0)) {
        await page.request
          .delete(`${apiBase(page.url())}/api/v1/drafts/${id}`, {
            headers: { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG },
          })
          .catch(() => {});
      }
    }
  });

  test(`P4 at order detail: Down then Enter in the panel closes it, edit cancelled @ ${vp.name}`, async ({
    page,
    context,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await setTenantCookie(context, BASE);
    const { orderId } = await discoverEditableOrder(page);
    await page.goto(`/orders/${orderId}`);
    await page
      .getByRole("button", { name: /^Edit (Items|order)/ })
      .first()
      .click({ timeout: 15_000 });
    await page.getByRole("button", { name: "Price history" }).first().click({ timeout: 15_000 });
    const panel = page.getByRole("dialog", { name: "Price history" });
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("ArrowDown");
    await expect(panel.locator('tbody tr[aria-selected="true"]').first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveCount(0, { timeout: 5_000 });
    // never save: leave the edit session
    await page
      .getByRole("button", { name: /^Cancel/ })
      .first()
      .click({ timeout: 10_000 });
  });
}
