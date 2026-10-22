/**
 * POS stack smoke (72): the counter sale's POS-1 / POS-2 / POS-3 behaviour against the real stack.
 *   scan 2 items -> edit a qty -> add a note -> remove + Undo -> pick a customer (re-price) -> layout -> Complete & show receipt.
 * Layout at 390 (one column, no horizontal overflow), 768 and 1440 (two columns). The sale itself is rung once, at 1440.
 *
 * LOCAL LANE ONLY, same guards as 71: the tenant is put on the in_store_shipping_retailer profile (counter on) via
 * helpers/local-fulfilment-profile.ts and restored row-for-row in afterAll. The only data written besides that config is the
 * one counter sale on the approved test tenant. Products and customer are DISCOVERED over the API. Needs `npm run local:sa`.
 */
import { test, expect, request as pwRequest, type Page } from "@playwright/test";
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

/** Throwaway rows this run created; retired in afterAll (also after a failure). */
const created: {
  api: string;
  headers: Record<string, string>;
  productId: string;
  customerId: string;
}[] = [];

async function retireThrowaways() {
  // Belt and braces: an earlier aborted run may have left rows with OUR prefix active; retire those too (soft).
  for (const c of created) {
    const ctx = await pwRequest.newContext();
    try {
      const custs: any = await (
        await ctx.get(`${c.api}/customers`, {
          headers: c.headers,
          params: { search: "QA POS Tier2", limit: "100" },
        })
      ).json();
      for (const row of custs?.data ?? []) {
        if (String(row.businessName ?? "").startsWith("QA POS Tier2 ") && row.id !== c.customerId) {
          await ctx.patch(`${c.api}/customers/${row.id}/status`, {
            headers: c.headers,
            data: { status: "INACTIVE" },
          });
        }
      }
      const prods: any = await (
        await ctx.get(`${c.api}/products`, {
          headers: c.headers,
          params: { search: "QA POS Tier Item", limit: "100" },
        })
      ).json();
      for (const row of prods?.data ?? []) {
        if (String(row.name ?? "").startsWith("QA POS Tier Item ") && row.id !== c.productId) {
          await ctx.patch(`${c.api}/products/${row.id}`, {
            headers: c.headers,
            data: { isActive: false },
          });
        }
      }
    } finally {
      await ctx.dispose();
    }
    break; // one sweep per run
  }
  for (const c of created.splice(0)) {
    const ctx = await pwRequest.newContext();
    try {
      // SOFT retire, never a hard delete: deactivate the product, set the customer INACTIVE, then READ BACK.
      const p = await ctx.patch(`${c.api}/products/${c.productId}`, {
        headers: c.headers,
        data: { isActive: false },
      });
      expect(p.ok(), `deactivate the throwaway product: ${p.status()}`).toBeTruthy();
      const cu = await ctx.patch(`${c.api}/customers/${c.customerId}/status`, {
        headers: c.headers,
        data: { status: "INACTIVE" },
      });
      expect(cu.ok(), `archive the throwaway customer: ${cu.status()}`).toBeTruthy();
      const prod: any = await (
        await ctx.get(`${c.api}/products/${c.productId}`, { headers: c.headers })
      ).json();
      expect(prod?.isActive, "the throwaway product reads back inactive").toBe(false);
      const cust = JSON.stringify(
        await (await ctx.get(`${c.api}/customers/${c.customerId}`, { headers: c.headers })).json(),
      );
      expect(cust, "the throwaway customer reads back INACTIVE").toContain('"status":"INACTIVE"');
    } finally {
      await ctx.dispose();
    }
  }
}

test.afterAll(async () => {
  test.setTimeout(120_000);
  await retireThrowaways();
  if (!before) return;
  const restored = await restoreFulfilmentConfig(target(), before);
  expect(restored, "the tenant's fulfilment config is back exactly as it was").toBe(true);
  await waitForApiCapability(target(), capabilityBefore, 60_000);
});

/**
 * A throwaway tier-2 customer and a throwaway product whose tier-2 price differs (10.00 -> 8.00), created through the operator
 * API on the approved test tenant and retired (inactive / archived, never hard-deleted) in afterAll, so the re-price is
 * ALWAYS observable whatever the seed holds. The local-target guard (local web + API + DB, not GitHub Actions, approved test
 * tenant) and assertTestTenant run BEFORE anything is created; the project is also only registered on a local lane.
 */
async function makeTierFixtures(page: Page, api: string, headers: Record<string, string>) {
  assertLocalFulfilmentTarget(target());
  assertTestTenant(TENANT_SLUG, "spec 72 throwaway fixtures");
  const tag = Date.now().toString(36).toUpperCase();
  const prod = await page.request.post(`${api}/products`, {
    headers,
    data: {
      name: `QA POS Tier Item ${tag}`,
      sku: `QAPOS${tag}`,
      unit: "each",
      pricePerUnit: "10.00",
      priceTier2: "8.00",
    },
  });
  expect(prod.ok(), `create the tier product: ${prod.status()}`).toBeTruthy();
  const product: any = await prod.json();
  const cust = await page.request.post(`${api}/customers`, {
    headers,
    data: {
      businessName: `QA POS Tier2 ${tag}`,
      contactName: "QA POS",
      username: `qa-pos-${tag.toLowerCase()}`,
      pricingTier: 2,
    },
  });
  expect(cust.ok(), `create the tier-2 customer: ${cust.status()}`).toBeTruthy();
  const customer: any = ((await cust.json()) as any).customer; // POST /customers wraps the row
  created.push({ api, headers, productId: product.id, customerId: customer.id });
  return { product, customer };
}

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
  return { products: sellable.slice(0, 2), api, headers };
}

for (const vp of VIEWPORTS) {
  test.describe(`POS stack counter @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("scan, typed qty, note, remove + Undo, customer re-price, layout", async ({
      page,
      context,
    }) => {
      await setTenantCookie(context, BASE);
      const { products, api, headers } = await discover(page);
      const fx = await makeTierFixtures(page, api, headers);
      try {
        const tierItem = fx.product;
        const other = products[0];
        await page.goto("/orders/counter-sale");
        const scanField = page.getByLabel("Scan or search items");
        await expect(scanField).toBeVisible({ timeout: 15_000 });
        const items = page.getByRole("list", { name: "Items" });
        for (const p of [tierItem, other]) {
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
        const overflow = () =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
        expect(await overflow(), "no horizontal overflow").toBeLessThanOrEqual(0);

        // typed quantity on the tier item: 2 x 10.00 (steppers stay beside it)
        const nameA = String(tierItem.name);
        const qty = page.getByLabel(`Set quantity of ${nameA}`);
        await qty.fill("2");
        await qty.press("Enter");
        await expect(qty).toHaveValue("2");
        await expect(items.getByRole("listitem").filter({ hasText: nameA })).toContainText(
          "20.00",
          {
            timeout: 10_000,
          },
        );
        await expect(
          page.getByRole("button", { name: `Add one ${nameA}`, exact: true }),
        ).toBeVisible();

        // note (single-line input)
        await page.getByRole("button", { name: `Add a note to ${nameA}`, exact: true }).click();
        const noteBox = page.getByLabel(`Note for ${nameA}`);
        expect(await noteBox.evaluate((el) => el.tagName)).toBe("INPUT");
        await noteBox.fill("smoke note");
        await page.getByRole("button", { name: `Edit the note on ${nameA}`, exact: true }).click();
        await expect(page.getByTestId("line-note")).toHaveText("smoke note");

        // remove + Undo
        const totalEl = page.getByTestId("running-total");
        const totalWithBoth = await totalEl.textContent();
        await page.getByRole("button", { name: `Remove ${nameA}`, exact: true }).click();
        await expect(items.getByRole("listitem")).toHaveCount(1);
        await page.getByRole("button", { name: `Undo: put back ${nameA}`, exact: true }).click();
        await expect(items.getByRole("listitem")).toHaveCount(2);
        await expect(totalEl).toHaveText(totalWithBoth ?? "");
        await expect(page.getByTestId("line-note")).toHaveText("smoke note");

        // pick the tier-2 customer: the cart re-prices (10.00 -> 8.00), UNCONDITIONALLY noted with the tier name
        await page
          .getByLabel("Find a customer")
          .fill(String(fx.customer.businessName).slice(0, 12));
        await page
          .getByRole("option", { name: String(fx.customer.businessName) })
          .first()
          .click();
        const note = page.getByTestId("counter-reprice-note");
        await expect(note).toContainText("Prices updated for", { timeout: 15_000 });
        await expect(note).toContainText(String(fx.customer.businessName));
        await expect(note).toContainText(/\(.+\)\./); // "(<tier name>)."
        await expect(page.getByTestId("counter-reprice-busy")).toHaveCount(0);
        await expect(page.getByTestId("counter-reprice-failed")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Complete & show receipt" })).toBeEnabled();
        await expect(page.getByTestId("line-note")).toHaveText("smoke note"); // survives the re-price
        await expect(items.getByRole("listitem").filter({ hasText: nameA })).toContainText("16.00"); // 2 x 8.00

        // the re-price Undo reverts prices only: the customer stays
        await note.getByRole("button", { name: "Undo" }).click();
        await expect(items.getByRole("listitem").filter({ hasText: nameA })).toContainText("20.00");
        await expect(page.getByText(String(fx.customer.businessName)).first()).toBeVisible();

        expect(await overflow(), "no horizontal overflow after the pick").toBeLessThanOrEqual(0);
      } finally {
        // retired in afterAll (also after a failure)
      }
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

/**
 * R7b batch 1 "say the money at the till". Written against the real stack like the rest of this file; the lead runs it on the
 * one proof stack (it is not run in the build lane). Each test rings at most one cash sale on the approved test tenant.
 */
test.describe("R7b till: change due note and the keyboard path to pay", () => {
  for (const width of [1280, 390]) {
    test(`Complete & next sale keeps Change due in the note @ ${width}`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await setTenantCookie(context, BASE);
      const { products } = await discover(page);
      await page.goto("/orders/counter-sale");
      const scanField = page.getByLabel("Scan or search items");
      await expect(scanField).toBeVisible({ timeout: 15_000 });
      await scanField.fill(String(products[0].sku));
      await scanField.press("Enter");
      await expect(page.getByRole("list", { name: "Items" }).getByRole("listitem")).toHaveCount(1, {
        timeout: 15_000,
      });
      await page.getByLabel("Amount tendered").fill("1000");
      await page.getByRole("button", { name: "Complete & next sale" }).click();
      await expect(page.getByTestId("counter-last-sale")).toContainText("Change due", {
        timeout: 20_000,
      });
    });
  }

  test("keyboard only: scan, Enter, type the tender, Enter shows the receipt @ 1280", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await setTenantCookie(context, BASE);
    const { products } = await discover(page);
    await page.goto("/orders/counter-sale");
    const scanField = page.getByLabel("Scan or search items");
    await expect(scanField).toBeVisible({ timeout: 15_000 });
    for (const p of products) {
      await scanField.fill(String(p.sku));
      await scanField.press("Enter");
    }
    await expect(page.getByRole("list", { name: "Items" }).getByRole("listitem")).toHaveCount(2, {
      timeout: 15_000,
    });
    await scanField.press("Enter"); // empty scan box with lines: focus moves to the payment
    await expect(page.getByLabel("Amount tendered")).toBeFocused();
    await page.keyboard.type("1000");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("counter-sale-receipt")).toBeVisible({ timeout: 20_000 });
  });

  for (const width of [390, 768]) {
    test(`the checkout bar names the chosen tender below md only @ ${width}`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      await setTenantCookie(context, BASE);
      const { products } = await discover(page);
      await page.goto("/orders/counter-sale");
      const scanField = page.getByLabel("Scan or search items");
      await expect(scanField).toBeVisible({ timeout: 15_000 });
      await scanField.fill(String(products[0].sku));
      await scanField.press("Enter");
      await expect(page.getByRole("list", { name: "Items" }).getByRole("listitem")).toHaveCount(1, {
        timeout: 15_000,
      });
      const row = page.getByTestId("counter-bar-tender");
      if (width < 768) {
        await expect(row).toBeVisible();
        await expect(row).toContainText("Cash");
        await row.click(); // Change payment: the Payment section scrolls into view
        await expect(page.getByRole("radio", { name: "Cash" })).toBeFocused();
      } else {
        await expect(row).toBeHidden(); // md: the static column, nothing changes
      }
    });
  }

  test("a walk-in line in a licence category shows its note before any Complete @ 1280", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await setTenantCookie(context, BASE);
    const { api, headers } = await discover(page);
    const cats: any = await (
      await page.request.get(`${api}/tracked-categories`, { headers })
    ).json();
    const licensed = (Array.isArray(cats) ? cats : []).find(
      (c: any) => c?.requiresLicense && c?.active,
    );
    test.skip(!licensed, "the test tenant has no licence-needing category with a product");
    const prods: any = await (
      await page.request.get(`${api}/products`, { headers, params: { limit: "100" } })
    ).json();
    const item = (prods?.data ?? []).find(
      (p: any) => p?.isActive !== false && p?.trackedCategoryId === licensed.id && p?.sku,
    );
    test.skip(!item, "no active product with a SKU in the licence category");
    await page.goto("/orders/counter-sale");
    const scanField = page.getByLabel("Scan or search items");
    await expect(scanField).toBeVisible({ timeout: 15_000 });
    await scanField.fill(String(item.sku));
    await scanField.press("Enter");
    await expect(page.getByTestId("line-license-note")).toContainText("Needs a licensed customer", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("counter-license-note")).toHaveCount(1);
  });

  test("a boxed product's register line names the pack size and the price each @ 1280", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await setTenantCookie(context, BASE);
    const { api, headers } = await discover(page);
    const prods: any = await (
      await page.request.get(`${api}/products`, { headers, params: { limit: "100" } })
    ).json();
    const boxed = (prods?.data ?? []).find(
      (p: any) => p?.isActive !== false && Number(p?.unitsPerBox) > 1 && p?.sku,
    );
    test.skip(!boxed, "the test tenant has no active boxed product with a SKU");
    await page.goto("/orders/counter-sale");
    const scanField = page.getByLabel("Scan or search items");
    await expect(scanField).toBeVisible({ timeout: 15_000 });
    await scanField.fill(String(boxed.sku));
    await scanField.press("Enter");
    const row = page.getByRole("list", { name: "Items" }).getByRole("listitem").first();
    await expect(row).toContainText(`of ${Number(boxed.unitsPerBox)}`, { timeout: 15_000 });
    await expect(page.getByTestId("line-unit-price")).toContainText("each");
  });
});

/** B1182: below md a toast sits above the sticky checkout bar (the register publishes --toast-bottom-inset). No sale is rung. */
test.describe("R7b till: toasts clear the sticky bar", () => {
  test("the Counter opened toast does not cover the checkout bar @ 390", async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setTenantCookie(context, BASE);
    await page.addInitScript(() => window.localStorage.setItem("rf-open-counter", "true"));
    await page.goto("/dashboard");
    const toast = page.getByText("Counter opened", { exact: true });
    await expect(toast).toBeVisible({ timeout: 15_000 });
    const bar = page.getByTestId("counter-checkout-bar");
    await expect(bar).toBeVisible({ timeout: 15_000 });
    await testInfo.attach("toast-390", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    const toastBox = await toast.boundingBox();
    const barBox = await bar.boundingBox();
    expect(toastBox).not.toBeNull();
    expect(barBox).not.toBeNull();
    expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(barBox!.y);
  });
});
