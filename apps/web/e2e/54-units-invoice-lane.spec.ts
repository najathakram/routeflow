/**
 * VU-4a / B1218 — the box / piece / unit picker on /invoices/new, end to end (local compose, test tenant,
 * flag.units_v1 on). Fixture (apps/api/scripts/e2e-seed.js `ensureUnitsFixture`): SKU "E2E-FIX-CASEDEFAULT"
 * ("E2E Fixture Case Default"): a Box of 24 @ $48.00 whose Case (12 pcs @ $24.00) is the DEFAULT selling unit.
 * The same product serves the mobile Expo-web proof. Customer: "E2E Fixture Deli Three" (as 53-units-order-lane).
 * A missing fixture is a HARD FAILURE naming the seed, never a skip.
 *
 * Money is asserted from the saved invoice (server truth), not from the screen alone:
 *   - New sale, a Case line: the invoice detail shows "N Cases" and the right total.
 *   - Other charge, a Case line: Preview, edit the count, Preview, Save draft -> the draft holds the EDITED line.
 *   - Piece: 2 pieces of the 24-pack are PRORATED ($48 x 2/24 = $4.00), never a per-piece price x qty.
 *   - Box <-> Case keeps the total (1 Box = 2 Cases = $48.00).
 *   - 1440 / 768 / 390: the picker is visible and the row does not scroll sideways.
 * The flag-off lane (old Case | Unit switch) needs a tenant WITHOUT flag.units_v1; e2e-routeflow holds the grant,
 * so that parity is proven by page.unit-picker.test.tsx (P1) and the apple-ux parity probe instead.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
const SKU = "E2E-FIX-CASEDEFAULT";
const PRODUCT_NAME = "E2E Fixture Case Default";
const CUSTOMER_NAME = "E2E Fixture Deli Three";
const SEED_HINT = "`node apps/api/scripts/e2e-seed.js` seeds the Case-default fixture (VU-4a).";

async function headersOf(page: Page) {
  const token = await operatorAccessToken(page);
  expect(token, "no operator access token: operator storageState is stale").toBeTruthy();
  return { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
}

async function openBuilder(page: Page, basis: RegExp) {
  await page.goto("/invoices/new");
  await page.getByRole("button", { name: basis }).click();
  await page.getByPlaceholder(/search customers/i).click();
  await page.getByPlaceholder(/search customers/i).fill(CUSTOMER_NAME);
  await page.getByText(CUSTOMER_NAME, { exact: true }).first().click();
}
async function addFixtureProduct(page: Page) {
  // A picker tap (the suggestion list), which starts a new line on the product's default selling unit.
  const scan = page.getByPlaceholder(/scan barcode, or type product name/i);
  await scan.fill(PRODUCT_NAME);
  await page
    .getByRole("listbox")
    .getByRole("button", { name: new RegExp(SKU, "i") })
    .click();
  await expect(page.locator(`input[value="${PRODUCT_NAME}"]`)).toBeVisible();
}
const picker = (page: Page) => page.getByRole("combobox", { name: `Sell ${PRODUCT_NAME} by` });

async function invoicesOfCustomer(request: APIRequestContext, page: Page) {
  const api = apiBase(page.url());
  const headers = await headersOf(page);
  const res = await request.get(
    `${api}/api/v1/invoices?search=${encodeURIComponent(CUSTOMER_NAME)}&limit=5`,
    {
      headers,
    },
  );
  expect(res.ok(), `GET /invoices returned ${res.status()}`).toBe(true);
  const body = await res.json();
  return { api, headers, rows: (body.data ?? body) as Array<{ id: string }> };
}

test.describe("Units v1 — the invoice unit picker (VU-4a)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ context, page, request }) => {
    await setTenantCookie(context, BASE);
    await page.goto("/orders");
    const headers = await headersOf(page);
    const api = apiBase(page.url());
    const res = await request.get(`${api}/api/v1/products?search=${encodeURIComponent(SKU)}`, {
      headers,
    });
    const body = await res.json();
    const rows = (body.data ?? body.products ?? body) as Array<{ id: string; sku?: string }>;
    const product = rows.find?.((p) => p.sku === SKU);
    expect(product, `Fixture product "${SKU}" not found: ${SEED_HINT}`).toBeTruthy();
    const units = await (
      await request.get(`${api}/api/v1/products/${product!.id}/units`, { headers })
    ).json();
    const caseUnit = (
      units as Array<{ label: string; factorToBase: number; isDefaultSelling: boolean }>
    ).find((u) => u.label === "Case");
    expect(caseUnit?.factorToBase, `fixture has no Case x12: ${SEED_HINT}`).toBe(12);
    expect(caseUnit?.isDefaultSelling, `Case is not the default unit: ${SEED_HINT}`).toBe(true);
  });

  test("New sale: a Case line lands on the invoice as N Cases at the right total", async ({
    page,
    request,
  }) => {
    await openBuilder(page, /new sale/i);
    await addFixtureProduct(page);
    await expect(picker(page)).toHaveValue("Case"); // the default start
    await page.getByLabel("Case count").fill("3");
    await page.getByRole("button", { name: /create sale & invoice/i }).click();
    await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{8,}/, { timeout: 20_000 });
    await expect(page.getByText("3 Cases")).toBeVisible();
    await expect(page.getByText("$72.00").first()).toBeVisible(); // 3 x $24.00
    const id = page.url().split("/").pop()!;
    const api = apiBase(page.url());
    const inv = await (
      await request.get(`${api}/api/v1/invoices/${id}`, { headers: await headersOf(page) })
    ).json();
    const line = inv.items[0];
    expect(line).toMatchObject({ unitLabel: "Case", unitsPerBox: 12 });
    expect(Number(line.subtotal)).toBe(72);
  });

  test("Other charge: Preview, edit the count, Preview, Save draft: the draft holds the EDITED line", async ({
    page,
    request,
  }) => {
    await openBuilder(page, /other charge \(a fee or correction with no order\)/i);
    await addFixtureProduct(page);
    await expect(picker(page)).toHaveValue("Case");
    await page.getByLabel("Case count").fill("2");
    await page.getByRole("button", { name: /^preview$/i }).click();
    await expect(page.getByTitle("Invoice preview")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /^close$/i }).click();
    await page.getByLabel("Case count").fill("5");
    await page.getByRole("button", { name: /^preview$/i }).click();
    await expect(page.getByTitle("Invoice preview")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /^close$/i }).click();
    await page.getByRole("button", { name: /save as draft/i }).click();
    await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{8,}/, { timeout: 20_000 });
    const id = page.url().split("/").pop()!;
    const api = apiBase(page.url());
    const inv = await (
      await request.get(`${api}/api/v1/invoices/${id}`, { headers: await headersOf(page) })
    ).json();
    expect(inv.status).toBe("DRAFT");
    expect(inv.items).toHaveLength(1);
    expect(inv.items[0]).toMatchObject({ unitLabel: "Case", unitsPerBox: 12 });
    expect(Number(inv.items[0].boxes)).toBe(5);
    expect(Number(inv.items[0].subtotal)).toBe(120); // 5 x $24.00
    void invoicesOfCustomer;
  });

  test("Piece (2 of the 24-pack) is prorated and Box <-> Case keeps the total", async ({
    page,
    request,
  }) => {
    await openBuilder(page, /other charge \(a fee or correction with no order\)/i);
    await addFixtureProduct(page);
    await picker(page).selectOption("Piece");
    await page.getByTitle("Total units").fill("2");
    await expect(page.getByText("= $4.00")).toBeVisible(); // 48 x 2/24, never 2 x a per-piece price
    await picker(page).selectOption("");
    await page.getByTitle("Cases").fill("1");
    await page.getByTitle("Extra loose units").fill("0");
    await expect(page.getByText("= $48.00")).toBeVisible();
    await picker(page).selectOption("Case");
    await page.getByLabel("Case count").fill("2");
    await expect(page.getByText("= $48.00")).toBeVisible(); // 2 Cases == 1 Box
    await picker(page).selectOption("");
    await page.getByRole("button", { name: /save as draft/i }).click();
    await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{8,}/, { timeout: 20_000 });
    const id = page.url().split("/").pop()!;
    const inv = await (
      await request.get(`${apiBase(page.url())}/api/v1/invoices/${id}`, {
        headers: await headersOf(page),
      })
    ).json();
    expect(inv.items[0].unitLabel ?? null).toBeNull();
    expect(Number(inv.items[0].subtotal)).toBe(48);
  });

  for (const [name, width, height] of [
    ["1440", 1440, 900],
    ["768", 768, 1024],
    ["390", 390, 844],
  ] as const) {
    test(`the picker is visible and the row does not scroll sideways at ${name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await openBuilder(page, /other charge \(a fee or correction with no order\)/i);
      await addFixtureProduct(page);
      await expect(picker(page)).toBeVisible();
      await expect(page.getByLabel("Unit price")).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
      await page.screenshot({ path: `test-results/vu4a-picker-${name}.png` });
    });
  }
});
