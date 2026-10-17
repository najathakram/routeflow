/**
 * Units v2 (units-v2-details-stale-price): a Details save never restores a stale price (R1, money).
 *   A v2 grid save (POST /products/:id/prices) used to update only the price-grid cache, so the Details form kept the
 *   price it opened with and the next Details save, even a plain rename, wrote the OLD case price back.
 *
 * LOCAL LANE ONLY (project `units-v2`). Run it RED on master, GREEN on the fix.
 * Writes on the approved test tenant only (assertTestTenant first): one throwaway boxed product (Box of 12, Retail 24.00),
 * its name and price restored and the product retired softly (inactive) in a finally.
 * A tenant not served `flag.units_prices_v2` FAILS the spec (never skips).
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { UNITS_V2_IDS as ID } from "./helpers/units-v2-ids";
import { requireUnitsV2Flag } from "./helpers/units-v2-support";

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const START = 24;
const NEXT = 31.5;
const TIER = 1; // Retail: the anchor row's Retail cell is always editable

type Ctx = { api: string; headers: Record<string, string> };

const readProduct = async (page: Page, ctx: Ctx, id: string) => {
  const res = await page.request.get(`${ctx.api}/products/${id}`, { headers: ctx.headers });
  expect(res.ok(), `GET product returned ${res.status()}`).toBe(true);
  return (await res.json()) as { name: string; pricePerUnit: string | number };
};

test.describe("Units v2 Details save after a v2 price save @ 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a rename in Details keeps the price the v2 grid just saved", async ({ page, context }) => {
    assertTestTenant(TENANT_SLUG, "units-v2 details stale price fixtures");
    await setTenantCookie(context, BASE);
    const ctx = await requireUnitsV2Flag(page);

    const tag = Date.now().toString(36).toUpperCase();
    const name = `QA UV2 Stale ${tag}`;
    const created = await page.request.post(`${ctx.api}/products`, {
      headers: ctx.headers,
      data: {
        name,
        sku: `QAUV2X${tag}`,
        unit: "Box",
        unitsPerBox: 12,
        pricePerUnit: START.toFixed(2),
      },
    });
    expect(created.ok(), `create the throwaway product: ${created.status()}`).toBeTruthy();
    const id = ((await created.json()) as { id: string }).id;

    try {
      // 1. The case price before anything changes.
      expect(Number((await readProduct(page, ctx, id)).pricePerUnit)).toBe(START);

      // 2. Change it in the v2 grid: edit the anchor Retail cell, save with the save bar.
      await page.goto(`/products/${id}`);
      await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });
      const grid = await page.request.get(`${ctx.api}/products/${id}/price-grid`, {
        headers: ctx.headers,
      });
      expect(grid.ok(), `GET price-grid returned ${grid.status()}`).toBe(true);
      const ref = ((await grid.json()) as { anchor: string }).anchor;
      const cell = page.locator(`[data-testid="${ID.cell(ref, TIER)}"]:visible`);
      const input = page.locator(`[data-testid="${ID.input(ref, TIER)}"]:visible`);
      await cell.getByRole("button").click();
      await expect(input).toBeFocused();
      await input.fill(String(NEXT));
      const saved = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname.endsWith(`/products/${id}/prices`),
      );
      await page.locator(`[data-testid="${ID.ebSave}"]:visible`).click();
      expect((await saved).ok()).toBe(true);
      await expect(page.locator(`[data-testid="${ID.saveStatus}"]:visible`).first()).toContainText(
        /Saved/,
        { timeout: 15_000 },
      );
      // The server holds the new price. (No reload: the page must cope with what it already has.)
      expect(Number((await readProduct(page, ctx, id)).pricePerUnit)).toBe(NEXT);

      // 3. Open Details edit, rename, save.
      await page.locator('button[title="Edit product"]').first().click();
      const nameInput = page.locator(`input[value="${name}"]`).first();
      await expect(nameInput).toBeVisible({ timeout: 10_000 });
      await nameInput.fill(`${name} R`);
      const patched = page.waitForResponse(
        (r) =>
          r.request().method() === "PATCH" && new URL(r.url()).pathname.endsWith(`/products/${id}`),
      );
      await page.getByRole("button", { name: /save/i }).first().click();
      const patchResp = await patched;
      expect(patchResp.status()).toBeLessThan(300);

      // 4. The product, read back through the API, still carries the NEW price (and the new name).
      const after = await readProduct(page, ctx, id);
      expect(after.name).toBe(`${name} R`);
      expect(Number(after.pricePerUnit), "the rename must not restore the old case price").toBe(
        NEXT,
      );
    } finally {
      // Restore the name and the price, then retire the throwaway product softly.
      const restore = await page.request.patch(`${ctx.api}/products/${id}`, {
        headers: ctx.headers,
        data: { name, pricePerUnit: START.toFixed(2) },
      });
      expect(restore.ok(), `restore the name and price: ${restore.status()}`).toBeTruthy();
      const retire = await page.request.patch(`${ctx.api}/products/${id}`, {
        headers: ctx.headers,
        data: { isActive: false },
      });
      expect(retire.ok(), `retire the throwaway product: ${retire.status()}`).toBeTruthy();
    }
  });

  test("renaming a non-pack unit in the legacy card keeps the price the v2 grid just saved", async ({
    page,
    context,
  }) => {
    assertTestTenant(TENANT_SLUG, "units-v2 legacy card stale price fixtures");
    await setTenantCookie(context, BASE);
    const ctx = await requireUnitsV2Flag(page);

    const tag = Date.now().toString(36).toUpperCase();
    const created = await page.request.post(`${ctx.api}/products`, {
      headers: ctx.headers,
      data: {
        name: `QA UV2 Stale Unit ${tag}`,
        sku: `QAUV2Y${tag}`,
        unit: "Box",
        unitsPerBox: 12,
        pricePerUnit: START.toFixed(2),
      },
    });
    expect(created.ok(), `create the throwaway product: ${created.status()}`).toBeTruthy();
    const id = ((await created.json()) as { id: string }).id;
    const unitPrice = START * 20;
    const unitNext = NEXT * 20;
    let unitId = "";
    const unitLabel = "Pallet";

    try {
      // A non-pack unit with its own explicit price (Pallet = 20 boxes).
      const unit = await page.request.post(`${ctx.api}/products/${id}/units`, {
        headers: ctx.headers,
        data: { label: unitLabel, factorToBase: 240, price: unitPrice.toFixed(2) },
      });
      expect(unit.ok(), `create the unit: ${unit.status()}`).toBeTruthy();
      unitId = ((await unit.json()) as { id: string }).id;
      const readUnit = async () => {
        const res = await page.request.get(`${ctx.api}/products/${id}/units`, {
          headers: ctx.headers,
        });
        expect(res.ok(), `GET units returned ${res.status()}`).toBe(true);
        return ((await res.json()) as { id: string; label: string; price: string | null }[]).find(
          (u) => u.id === unitId,
        )!;
      };

      // 1. Move the unit's price in the v2 grid (its own row), with the save bar.
      await page.goto(`/products/${id}`);
      await expect(page.getByTestId(ID.grid)).toBeVisible({ timeout: 20_000 });
      const grid = await page.request.get(`${ctx.api}/products/${id}/price-grid`, {
        headers: ctx.headers,
      });
      expect(grid.ok(), `GET price-grid returned ${grid.status()}`).toBe(true);
      const g = (await grid.json()) as { anchor: string; rows: { ref: string }[] };
      const ref = (g.rows.find((r) => r.ref === unitId) ?? g.rows.find((r) => r.ref !== g.anchor))!
        .ref;
      const cell = page.locator(`[data-testid="${ID.cell(ref, TIER)}"]:visible`);
      const input = page.locator(`[data-testid="${ID.input(ref, TIER)}"]:visible`);
      await cell.getByRole("button").click();
      await expect(input).toBeFocused();
      await input.fill(String(unitNext));
      const saved = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname.endsWith(`/products/${id}/prices`),
      );
      await page.locator(`[data-testid="${ID.ebSave}"]:visible`).click();
      expect((await saved).ok()).toBe(true);
      await expect(page.locator(`[data-testid="${ID.saveStatus}"]:visible`).first()).toContainText(
        /Saved/,
        { timeout: 15_000 },
      );
      expect(Number((await readUnit()).price)).toBe(unitNext);

      // 2. Rename that unit in the legacy Units card (no reload) and save the row.
      const nameInput = page.getByLabel(`${unitLabel} name`);
      await expect(nameInput).toBeVisible({ timeout: 10_000 });
      await nameInput.fill(`${unitLabel} R`);
      const row = page.locator('[data-testid="unit-row"]').filter({ has: nameInput });
      const patched = page.waitForResponse(
        (r) =>
          r.request().method() === "PATCH" &&
          new URL(r.url()).pathname.endsWith(`/products/${id}/units/${unitId}`),
      );
      await row.getByRole("button", { name: "Save", exact: true }).click();
      expect((await patched).status()).toBeLessThan(300);

      // 3. Read the unit back: renamed, and still at the v2 price.
      const after = await readUnit();
      expect(after.label).toBe("Pallet R");
      expect(Number(after.price), "the rename must not restore the old unit price").toBe(unitNext);
    } finally {
      // Restore the unit's name and price, then retire the throwaway product softly.
      if (unitId) {
        const restore = await page.request.patch(`${ctx.api}/products/${id}/units/${unitId}`, {
          headers: ctx.headers,
          data: { label: "Pallet", price: unitPrice.toFixed(2) },
        });
        expect(restore.ok(), `restore the unit name and price: ${restore.status()}`).toBeTruthy();
      }
      const retire = await page.request.patch(`${ctx.api}/products/${id}`, {
        headers: ctx.headers,
        data: { isActive: false },
      });
      expect(retire.ok(), `retire the throwaway product: ${retire.status()}`).toBeTruthy();
    }
  });
});
