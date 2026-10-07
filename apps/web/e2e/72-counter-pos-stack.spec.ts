/**
 * POS stack smoke (72): the counter sale's POS-1 / POS-2 / POS-3 behaviour against the real stack.
 *   scan 2 items -> edit a qty -> add a note -> remove + Undo -> pick a customer (re-price) -> layout -> Complete & show receipt.
 * Layout at 390 (one column, no horizontal overflow), 768 and 1440 (two columns). The sale itself is rung once, at 1440.
 *
 * LOCAL LANE ONLY, same guards as 71: the tenant is put on the in_store_shipping_retailer profile (counter on) via
 * helpers/local-fulfilment-profile.ts and restored row-for-row in afterAll. The only data written besides that config is the
 * one counter sale on the approved test tenant. Products and customer are DISCOVERED over the API. Needs `npm run local:sa`.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
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
const VIEWPORTS = [
  { name: "390", width: 390, height: 844, columns: 1 },
  { name: "768", width: 768, height: 1024, columns: 2 },
  { name: "1440", width: 1440, height: 900, columns: 2 },
] as const;

let before: FulfilmentSnapshot | null = null;
let capabilityBefore: unknown = null;
const target = () => localTarget(apiBase(BASE));

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

async function discover(page: Page) {
  await page.goto("/orders");
  const token = await operatorAccessToken(page);
  const api = `${apiBase(page.url())}/api/v1`;
  const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
  const prodRes = await page.request.get(`${api}/products`, { headers, params: { limit: "50" } });
  const products: any[] = ((await prodRes.json()) as any)?.data ?? [];
  const sellable = products.filter(
    (p) => p?.isActive !== false && /^[0-9A-Za-z-]{4,}$/.test(String(p?.sku ?? "")),
  );
  expect(sellable.length, "the tenant needs 2 active products with a SKU").toBeGreaterThanOrEqual(
    2,
  );
  const custRes = await page.request.get(`${api}/customers`, { headers, params: { limit: "50" } });
  const customers: any[] = ((await custRes.json()) as any)?.data ?? [];
  expect(customers.length, "the tenant needs at least one customer").toBeGreaterThan(0);
  const customer = customers.find((c) => (c?.pricingTier ?? 1) > 1) ?? customers[0];
  return { products: sellable.slice(0, 2), customer };
}

for (const vp of VIEWPORTS) {
  test.describe(`POS stack counter @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("scan, qty, note, remove + Undo, customer re-price, layout", async ({ page, context }) => {
      await setTenantCookie(context, BASE);
      const { products, customer } = await discover(page);
      const [a, b] = products;
      await page.goto("/orders/counter-sale");
      const scanField = page.getByLabel("Scan or search items");
      await expect(scanField).toBeVisible({ timeout: 15_000 });
      const items = page.getByRole("list", { name: "Items" });
      for (const p of [a, b]) {
        await scanField.fill(String(p.sku));
        await scanField.press("Enter");
      }
      await expect(items.getByRole("listitem")).toHaveCount(2, { timeout: 15_000 });

      // layout: columns by width, never a horizontal scroll
      const cols = await page
        .getByTestId("counter-sale-columns")
        .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
      if (vp.columns === 2) expect(cols).toBe(2);
      else expect(cols).toBeLessThanOrEqual(1);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, "no horizontal overflow").toBeLessThanOrEqual(0);

      // edit a qty on the first line (plain "Add one" or a boxed line's "Add a piece")
      const totalEl = page.getByTestId("running-total");
      const totalBefore = await totalEl.textContent();
      await items
        .getByRole("listitem")
        .first()
        .getByRole("button", { name: /^Add (one|a piece to) / })
        .click();
      await expect(totalEl).not.toHaveText(totalBefore ?? "");

      // note
      const nameA = String(a.name);
      await page.getByRole("button", { name: `Add a note to ${nameA}`, exact: true }).click();
      await page.getByLabel(`Note for ${nameA}`).fill("smoke note");
      await page.getByRole("button", { name: `Edit the note on ${nameA}`, exact: true }).click();
      await expect(page.getByTestId("line-note")).toHaveText("smoke note");

      // remove + Undo
      const totalWithBoth = await totalEl.textContent();
      await page.getByRole("button", { name: `Remove ${nameA}`, exact: true }).click();
      await expect(items.getByRole("listitem")).toHaveCount(1);
      await page
        .getByRole("status", { name: "Removed item" })
        .getByRole("button", { name: "Undo" })
        .click();
      await expect(items.getByRole("listitem")).toHaveCount(2);
      await expect(totalEl).toHaveText(totalWithBoth ?? "");
      await expect(page.getByTestId("line-note")).toHaveText("smoke note");

      // pick a customer: the cart re-prices (display only); Complete is never left blocked
      await page.getByLabel("Find a customer").fill(String(customer.businessName).slice(0, 6));
      await page
        .getByRole("button", { name: String(customer.businessName) })
        .first()
        .click();
      await expect(page.getByTestId("counter-reprice-busy")).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByTestId("counter-reprice-failed")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Complete & show receipt" })).toBeEnabled();
      const note = page.getByTestId("counter-reprice-note");
      test.info().annotations.push({
        type: "reprice-note",
        description: (await note.count())
          ? ((await note.textContent()) ?? "")
          : "none (no price changed)",
      });
      if ((customer.pricingTier ?? 1) > 1 && (await note.count())) {
        await expect(note).toContainText("Prices updated");
      }
      await expect(page.getByTestId("line-note")).toHaveText("smoke note"); // the note survives the re-price

      const overflowAfter = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflowAfter, "no horizontal overflow after the pick").toBeLessThanOrEqual(0);
    });
  });
}

test.describe("POS stack counter: ring the sale @ 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Complete & show receipt shows the line note", async ({ page, context }) => {
    await setTenantCookie(context, BASE);
    const { products } = await discover(page);
    const [a, b] = products;
    await page.goto("/orders/counter-sale");
    const scanField = page.getByLabel("Scan or search items");
    await expect(scanField).toBeVisible({ timeout: 15_000 });
    for (const p of [a, b]) {
      await scanField.fill(String(p.sku));
      await scanField.press("Enter");
    }
    await expect(page.getByRole("list", { name: "Items" }).getByRole("listitem")).toHaveCount(2, {
      timeout: 15_000,
    });
    const nameA = String(a.name);
    await page.getByRole("button", { name: `Add a note to ${nameA}`, exact: true }).click();
    await page.getByLabel(`Note for ${nameA}`).fill("smoke note");
    await page.getByRole("button", { name: "Exact" }).click();
    await page.getByRole("button", { name: "Complete & show receipt" }).click();
    await expect(page.getByTestId("counter-sale-receipt")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Receipt" })).toBeFocused();
    await expect(page.getByTestId("receipt-line-note")).toHaveText("smoke note");
  });
});
