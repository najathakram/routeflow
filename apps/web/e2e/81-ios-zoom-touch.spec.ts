/**
 * SA-1071 A-2: iOS zooms into a focused field under 16px, so one rule in `globals.css` sets 16px on touch. Computed size is a
 * proxy: neither Chromium nor Playwright WebKit zooms, so these rows are enough to merge and not enough to claim the zoom.
 * IZ6 on a real iPhone or the iOS Simulator is the real proof. A row that reads 16 before the rule is a bad row: report it.
 *
 * The till needs a counter, and the e2e tenant has its counter off, so the features read is patched in the browser only.
 * Role: OPERATOR. Tenant: the approved e2e seed. READ-ONLY: nothing is submitted.
 */
import { test, expect, devices, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
const CUSTOMER_NAME = "E2E Fixture Deli Three";
const PRODUCT_NAME = "E2E Fixture Case Default";
const SKU = "E2E-FIX-CASEDEFAULT";
const { defaultBrowserType: _phoneBrowser, ...iPhone13 } = devices["iPhone 13"];

/** The lowest computed size across the text fields on screen. A row reading 16 or more passes. */
const lowestFieldSize = (page: Page) =>
  page.evaluate(() => {
    const skip = /^(checkbox|radio|range|file|color|hidden|button|submit|reset)$/;
    const sizes = [...document.querySelectorAll("input, textarea, select")]
      .filter((el) => !skip.test((el as HTMLInputElement).type))
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => parseFloat(getComputedStyle(el).fontSize));
    return { count: sizes.length, lowest: Math.min(...sizes) };
  });

async function expectFieldsAt16(page: Page) {
  await expect.poll(async () => (await lowestFieldSize(page)).count).toBeGreaterThan(0);
  expect((await lowestFieldSize(page)).lowest).toBeGreaterThanOrEqual(16);
}

const counterOn = (page: Page) =>
  page.route("**/tenants/me/features*", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    (json.data ?? json).capabilities.fulfilment.counter = "optional";
    await route.fulfill({ response, json });
  });

async function openTillWithALine(page: Page) {
  await counterOn(page);
  await page.goto("/orders/counter-sale");
  const scan = page.getByLabel("Scan or search items");
  await scan.fill(SKU);
  await scan.press("Enter");
  await expect(page.getByRole("list", { name: "Items" })).toContainText(PRODUCT_NAME, {
    timeout: 15_000,
  });
}

async function openInvoiceLine(page: Page) {
  await page.goto("/invoices/new");
  await page.getByRole("button", { name: /other charge/i }).click();
  await page.getByPlaceholder(/search customers/i).click();
  await page.getByPlaceholder(/search customers/i).fill(CUSTOMER_NAME);
  await page.getByText(CUSTOMER_NAME, { exact: true }).first().click();
  await page.getByPlaceholder(/scan barcode, or type product name/i).fill(PRODUCT_NAME);
  await page
    .getByRole("listbox")
    .getByRole("option", { name: new RegExp(SKU, "i") })
    .click();
}

test.beforeEach(async ({ context }) => {
  await setTenantCookie(context, BASE);
});

test.describe("phone, upright", () => {
  test.use({ ...iPhone13 });

  test("IZ1: the till, its Amount tendered and Change price fields", async ({ page }) => {
    await openTillWithALine(page);
    await expectFieldsAt16(page);
    await page.getByRole("radio", { name: "Cash" }).check({ force: true });
    await expect(page.getByLabel("Amount tendered")).toHaveCSS("font-size", "16px");
    await page
      .getByRole("button", { name: /^change price for/i })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(/price per|set price/i).first()).toHaveCSS("font-size", "16px");
    await expect(dialog.getByLabel(/^reason/i)).toHaveCSS("font-size", "16px");
  });

  for (const [flow, url] of [
    ["add customer", "/customers?action=new"],
    ["the order builder", "/orders?action=new&builder=1"],
    ["add product", "/products?action=new"],
  ] as const) {
    test(`IZ1: ${flow}`, async ({ page }) => {
      await page.goto(url);
      await expectFieldsAt16(page);
    });
  }

  test("IZ1: an invoice's own fields", async ({ page }) => {
    await openInvoiceLine(page);
    await expectFieldsAt16(page);
  });
});

test.describe("phone on its side", () => {
  test.use({ ...iPhone13, viewport: { width: 844, height: 390 } });

  test("IZ2: the customer form, the case a width class misses", async ({ page }) => {
    await page.goto("/customers?action=new");
    await expectFieldsAt16(page);
  });
});

test.describe("touch tablet", () => {
  test.use({ ...iPhone13, viewport: { width: 820, height: 1180 } });

  test("IZ3 and IZ5: an invoice line reads 16, holds 3 digits, and nothing overlaps", async ({
    page,
  }, testInfo) => {
    await openInvoiceLine(page);
    await expectFieldsAt16(page);
    const boxed = page.locator('input[type="number"][title]').first();
    if (await boxed.count()) {
      await boxed.fill("123");
      const fits = await boxed.evaluate((el: HTMLInputElement) => {
        const cs = getComputedStyle(el);
        const context = document.createElement("canvas").getContext("2d")!;
        context.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return context.measureText(el.value).width <= room;
      });
      expect(fits).toBe(true);
    }
    await testInfo.attach("iz3-invoice-820", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });
});

test("IZ4: a mouse keeps its sizes", async ({ page }) => {
  await page.goto("/customers?action=new");
  await expect.poll(async () => (await lowestFieldSize(page)).count).toBeGreaterThan(0);
  expect((await lowestFieldSize(page)).lowest).toBeLessThan(16);
  await openInvoiceLine(page);
  expect((await lowestFieldSize(page)).lowest).toBe(12);
});
