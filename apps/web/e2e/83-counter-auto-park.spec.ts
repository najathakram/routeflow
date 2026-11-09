/**
 * W-1184 + W-1186 (83): the counter parks a sale on every leave, and an unknown scan opens New product by itself.
 *   scan an item -> Exit counter -> "Sale parked" toast, no Discard question, left the counter
 *   -> back on the counter the one-tap "Resume sale" bar puts the line back (a parked sale rings once: resume takes it off the list)
 *   unknown barcode -> New product opens with the code in SKU; Esc skips and the cursor is back in the scan box.
 *
 * LOCAL LANE ONLY: the approved test tenant, products discovered over the API, nothing is completed or created
 * (the New product window is dismissed). The parked rows this spec makes are discarded at the end.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const COUNTER = "/orders/counter-sale";
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
] as const;

test.beforeAll(() => assertTestTenant(TENANT_SLUG));

async function discoverSku(page: Page): Promise<string> {
  const token = await operatorAccessToken(page);
  const res = await page.request.get(`${apiBase(page.url())}/api/v1/products`, {
    headers: { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG },
    params: { limit: "50" },
  });
  const products: any[] = ((await res.json()) as any)?.data ?? [];
  const p = products.find(
    (x) => x?.isActive !== false && /^[0-9A-Za-z-]{4,}$/.test(String(x?.sku ?? "")),
  );
  expect(p, "the tenant needs an active product with a SKU").toBeTruthy();
  return String(p.sku);
}

const lineRows = (page: Page) =>
  page
    .getByRole("list", { name: "Items" })
    .getByRole("listitem")
    .filter({ hasNotText: "No items yet" });

for (const vp of VIEWPORTS) {
  test.describe(`counter auto-park at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("Exit parks the sale with an Undo toast; Resume puts the line back", async ({
      page,
      context,
    }) => {
      await setTenantCookie(context, BASE);
      await page.goto("/orders");
      const sku = await discoverSku(page);
      await page.goto(COUNTER);
      const scan = page.getByLabel("Scan or search items");
      await expect(scan).toBeVisible({ timeout: 15_000 });
      await scan.fill(sku);
      await scan.press("Enter");
      await expect(lineRows(page)).toHaveCount(1, { timeout: 15_000 });

      await page.getByRole("button", { name: "Exit counter" }).click();
      await expect(page.getByText(/^Sale parked · 1 item/)).toBeVisible();
      await expect(page.getByText("Discard this sale?")).toHaveCount(0);
      await expect(page).toHaveURL(/\/orders$/);
      await page.screenshot({ path: `test-results/w1184-parked-toast-${vp.name}.png` });

      await page.goto(COUNTER);
      const bar = page.getByTestId("counter-resume-bar");
      await expect(bar).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: `test-results/w1184-resume-bar-${vp.name}.png` });
      await bar.getByRole("button", { name: /^Resume sale \(/ }).click();
      await expect(lineRows(page)).toHaveCount(1, { timeout: 15_000 });
      await expect(bar).toHaveCount(0); // taken back: it can never be rung twice

      // leave the lane clean: park again and discard it from the list
      await page.getByRole("button", { name: "Exit counter" }).click();
      await expect(page.getByText(/^Sale parked/)).toBeVisible();
      await page.goto(COUNTER);
      await page.getByRole("button", { name: /^Parked/ }).click();
      const dialog = page.getByRole("dialog", { name: "Parked sales" });
      const discards = dialog.getByRole("button", { name: /^Discard / });
      while ((await discards.count()) > 0) await discards.first().click(); // each one hides at once (Undo window)
      await expect(dialog.getByText("No parked sales.")).toBeVisible();
      await page.waitForTimeout(9_000); // the deletes leave once the Undo window has passed
    });

    test("an unknown scan opens New product with the code in SKU; Esc skips", async ({
      page,
      context,
    }) => {
      await setTenantCookie(context, BASE);
      await page.goto(COUNTER);
      const scan = page.getByLabel("Scan or search items");
      await expect(scan).toBeVisible({ timeout: 15_000 });
      const code = "0000000000017";
      await scan.fill(code);
      await scan.press("Enter");
      // a shop with tracked categories is asked the one required question first (compliance); answer No
      const ask = page.getByRole("heading", { name: "Is this a licensed or regulated item?" });
      const newProduct = page.getByRole("heading", { name: "New product" });
      await expect(ask.or(newProduct)).toBeVisible({ timeout: 15_000 });
      if (await ask.isVisible()) {
        await page.screenshot({ path: `test-results/w1186-regulated-question-${vp.name}.png` });
        await page.getByRole("button", { name: "No", exact: true }).click();
      }
      await expect(newProduct).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("textbox", { name: "Scan or type", exact: true })).toHaveValue(
        code,
      );
      await page.screenshot({ path: `test-results/w1186-new-product-${vp.name}.png` });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("heading", { name: "New product" })).toHaveCount(0);
      await expect(scan).toBeFocused();
    });
  });
}
