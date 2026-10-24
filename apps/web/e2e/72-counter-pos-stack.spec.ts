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

test.describe("W-715 / W-716: the receipt's Change row, one action row at 390, and Void sale", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("an exact cash sale: Change reads as a normal row, the actions are one row at 390, Void sale opens the dialog", async ({
    page,
    context,
  }) => {
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
    await page.getByRole("button", { name: "Exact" }).click();
    await page.getByRole("button", { name: "Complete & show receipt" }).click();
    await expect(page.getByTestId("counter-sale-receipt")).toBeVisible({ timeout: 20_000 });

    // W-715: Change $0.00 is not a second headline (same size as Subtotal, smaller than Total)
    const size = (id: string) =>
      page.getByTestId(id).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    await expect(page.getByTestId("receipt-change")).toContainText("$0.00");
    expect(await size("receipt-change")).toBe(await size("receipt-subtotal"));
    expect(await size("receipt-change")).toBeLessThan(await size("receipt-total"));

    // W-715: New sale, Print and More share one row at 390 and none runs off the screen
    await page.setViewportSize({ width: 390, height: 844 });
    const box = async (name: string) => {
      const b = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(b, `${name} is on screen`).not.toBeNull();
      return b!;
    };
    const [newSale, print, more] = [await box("New sale"), await box("Print"), await box("More")];
    expect(Math.abs(newSale.y - print.y)).toBeLessThan(2);
    expect(Math.abs(newSale.y - more.y)).toBeLessThan(2);
    expect(more.x + more.width).toBeLessThanOrEqual(390);

    // the rest stay reachable behind More
    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.getByRole("button", { name: "Email receipt" })).toBeVisible();

    // W-716 / F14: Void sale opens the void dialog for this sale; the reason is marked required up front
    await page.getByRole("button", { name: /^Void sale ORD/ }).click();
    const dialog = page.getByRole("dialog", { name: /Void sale/ });
    await expect(dialog).toContainText("$");
    await expect(dialog.getByLabel("Reason for voiding (required)")).toBeVisible();
    await dialog.getByRole("button", { name: "Keep sale" }).click();
    await expect(dialog).toBeHidden();
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
    // a cashier pauses; a scanner's CR+LF inside the window is swallowed by design (EMPTY_ENTER_QUIET_MS = 150)
    await page.waitForTimeout(250);
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
/**
 * Counter audit, batch "register and payment" (538 re-check F02 / F07, vital-few #7, rows 188 and 240). Nothing is sold and no
 * customer is created: a line is put on the cart, an amount is typed, the new-customer form is opened and cancelled.
 */
test.describe("register and payment polish", () => {
  for (const vp of VIEWPORTS) {
    test(`the scan field has an edge, the hint names Enter, a short tender says how short, New customer opens the form @ ${vp.name}`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await setTenantCookie(context, BASE);
      const { products } = await discover(page);
      await page.goto("/orders/counter-sale");
      const scanField = page.getByLabel("Scan or search items");
      await expect(scanField).toBeVisible({ timeout: 15_000 });

      // before any line: the multiply tip; no key hint yet
      await expect(page.getByTestId("scan-hint")).toHaveText("Type a quantity first to multiply.");

      // New customer (row 240): the typed text is the form's Business Name; cancelling creates nothing
      await page.getByLabel("Find a customer").fill("Qa Counter Prefill");
      await page.getByRole("button", { name: "New customer" }).click();
      const form = page.getByRole("dialog");
      await expect(form.getByLabel("Business Name")).toHaveValue("Qa Counter Prefill");
      await form.getByRole("button", { name: "Cancel" }).click();
      await expect(form).toHaveCount(0);
      await page.getByLabel("Find a customer").fill("");
      await page.getByRole("button", { name: "Walk-in" }).click();

      await scanField.fill(String(products[0].sku));
      await scanField.press("Enter");
      await expect(page.getByRole("list", { name: "Items" }).getByRole("listitem")).toHaveCount(1, {
        timeout: 15_000,
      });

      // vital-few #7: the sticky scan field carries a bottom edge
      const edge = await page
        .getByTestId("counter-scan-bar")
        .evaluate((el) => getComputedStyle(el).borderBottomWidth);
      expect(edge).toBe("1px");
      // F02: line in the cart + empty field -> the hint names the key that pays
      await expect(page.getByTestId("scan-hint")).toHaveText("Press Enter to pay.");

      // row 188: a small cash amount is short; the line says so while it is typed, and is not an alert
      const tender = page.getByLabel("Amount tendered");
      await tender.fill("0.01");
      await expect(page.getByTestId("tender-short")).toContainText("short");
      await expect(page.getByTestId("tender-short")).toBeVisible();
      await tender.fill("");
      await expect(page.getByTestId("tender-short")).toHaveCount(0);

      // W-714 decision: the bar's tender row stays below md (the Payment toggles sit under the bar at 390)
      if (vp.width < 768) await expect(page.getByTestId("counter-bar-tender")).toBeVisible();
    });
  }

  test("an offline Complete leaves the cursor on Complete, not the scan field @ 1440", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setTenantCookie(context, BASE);
    const { products } = await discover(page);
    await page.goto("/orders/counter-sale");
    const scanField = page.getByLabel("Scan or search items");
    await expect(scanField).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Walk-in" }).click();
    await scanField.fill(String(products[0].sku));
    await scanField.press("Enter");
    await expect(page.getByRole("list", { name: "Items" }).getByRole("listitem")).toHaveCount(1, {
      timeout: 15_000,
    });
    await page.getByLabel("Amount tendered").fill("1000");
    await context.setOffline(true);
    try {
      const complete = page.getByRole("button", { name: "Complete & show receipt" });
      await complete.click();
      await expect(page.getByRole("alert").filter({ hasText: "No connection" })).toBeVisible({
        timeout: 15_000,
      });
      await expect(complete).toBeFocused();
    } finally {
      await context.setOffline(false);
    }
  });
});

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

/**
 * SA-837b item 3 (row 498): the till's escape from a duplicate payment reference, at 390 / 768 / 1440. WRITTEN, NOT RUN in the
 * build lane (the orchestrator captures it on the proof stack). The ring is real; the answer of the FIRST counter-sale POST is
 * rewritten below into the exact "sale rung, payment refused as a duplicate" body the server returns for a repeated reference,
 * so no second payment with the same reference has to be seeded; the "Record anyway" resend goes through to the real server
 * (same key, same cart, payment.recordAnyway), as the signed-in staff cashier.
 */
test.describe("SA-837b till: Record anyway on a duplicate payment reference", () => {
  for (const vp of VIEWPORTS) {
    test(`the not-recorded state names the existing payment and Record anyway resends @ ${vp.name}`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await setTenantCookie(context, BASE);
      const { products } = await discover(page);
      let first: any = null;
      let resend: any = null;
      await page.route("**/orders/counter-sale", async (route) => {
        const req = route.request();
        if (req.method() !== "POST") return route.continue();
        const body = req.postDataJSON();
        if (body?.payment?.recordAnyway === true) {
          resend = { body, key: req.headers()["idempotency-key"] };
          return route.continue(); // the real server records it
        }
        first = { body, key: req.headers()["idempotency-key"] };
        const real = await route.fetch(); // the real server rings (and tenders) the sale; only its ANSWER is rewritten below
        const sale = await real.json();
        return route.fulfill({
          response: real,
          json: {
            ...sale,
            paid: 0,
            balanceDue: sale.total,
            paymentRecorded: false,
            paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
            paymentCauseCode: "DUPLICATE_PAYMENT_REF",
            existingPayment: {
              id: "00000000-0000-0000-0000-000000000000",
              paymentNumber: "PAY-QA-0001",
              paidAt: "2026-10-01T12:00:00.000Z",
              amount: sale.total,
              invoiceId: "00000000-0000-0000-0000-000000000001",
              invoiceNumber: "INV-QA-0042",
            },
          },
        });
      });
      await page.goto("/orders/counter-sale");
      const scanField = page.getByLabel("Scan or search items");
      await expect(scanField).toBeVisible({ timeout: 15_000 });
      await scanField.fill(String(products[0].sku));
      await scanField.press("Enter");
      await expect(page.getByRole("list", { name: "Items" }).getByRole("listitem")).toHaveCount(1, {
        timeout: 15_000,
      });
      await page.getByRole("radio", { name: "Check" }).click();
      await page.getByLabel("Check number").fill("QA-DUP-4242");
      await page.getByRole("button", { name: "Complete & show receipt" }).click();

      await expect(page.getByTestId("counter-payment-not-recorded")).toBeVisible({
        timeout: 20_000,
      });
      const panel = page.getByTestId("counter-payment-duplicate");
      await expect(panel).toBeVisible();
      await expect(panel).toContainText("A payment with this reference was already recorded on");
      await expect(panel).toContainText("INV-QA-0042");
      const action = panel.getByRole("button", { name: "Record anyway" });
      await expect(action).toBeVisible();
      const box = await action.boundingBox();
      expect(box!.height, "44 px target").toBeGreaterThanOrEqual(44);
      // no horizontal overflow at any width
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      await action.click();
      await expect(page.getByTestId("counter-payment-not-recorded")).toHaveCount(0, {
        timeout: 20_000,
      });
      await expect(page.getByTestId("counter-payment-duplicate")).toHaveCount(0);
      expect(resend?.key).toBe(first?.key); // the SAME sale, never a new one
      expect(resend?.body.payment).toEqual({ ...first.body.payment, recordAnyway: true });
    });
  }
});

/**
 * Interim till guard (owner P0): a check dated after the tenant's today cannot be tendered. NOT RUN in the authoring session
 * (needs `npm run local:sa` and the screen wiring of CounterCheckDetails). The date is two days ahead so it is in the future
 * in every tenant zone, whatever the browser's clock says. Nothing is rung: Complete is refused before any POST.
 */
const POSTDATED_SENTENCE =
  "Post-dated check: put this sale on account and record the check when it clears.";
function daysAheadIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
test.describe("R7b till: a post-dated check is not tendered", () => {
  for (const vp of VIEWPORTS) {
    test(`a check dated in the future shows the message and refuses Complete @ ${vp.name}`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
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
      await page.getByRole("radio", { name: "Check" }).click();
      await page.getByLabel("Check number").fill("1042");
      await expect(page.getByLabel("Check date")).toBeVisible();
      await expect(page.getByText(POSTDATED_SENTENCE)).toBeHidden(); // defaults to the tenant's today
      await page.getByLabel("Check date").fill(daysAheadIso(2));
      await expect(page.getByText(POSTDATED_SENTENCE)).toBeVisible();
      // a walk-in (the default customer-less sale) cannot go on account: the one button is there but disabled
      const putOnAccount = page.getByRole("button", { name: "Put this sale on account" });
      await expect(putOnAccount).toBeVisible();
      await expect(putOnAccount).toBeDisabled();
      // Complete is refused with the same sentence IN THE CHECKOUT BAR's own alert (not the inline fields' one, which
      // already shows it), and no POST to the counter-sale endpoint left the page.
      const counterPosts: string[] = [];
      page.on("request", (r) => {
        if (r.method() === "POST" && /\/orders\/counter-sale\/?$/.test(new URL(r.url()).pathname)) {
          counterPosts.push(r.url());
        }
      });
      await page
        .getByRole("button", { name: /^Complete/ })
        .first()
        .click();
      await expect(page.getByTestId("counter-checkout-bar").getByRole("alert")).toHaveText(
        POSTDATED_SENTENCE,
      );
      expect(counterPosts).toEqual([]);
      await expect(page.getByRole("radio", { name: "Check" })).toBeChecked();
      await expect(page.getByTestId("counter-last-sale")).toHaveCount(0);
    });
  }
});
