/**
 * W-867 (SA-946, SA-961 R1): a product's first pack asks what the stock number was counted in.
 *
 * LOCAL LANE ONLY (project `units-v2`). Writes on the approved test tenant only (assertTestTenant first): one throwaway
 * product per test (10 on hand at 48.00, Retail 240.00, no pack), retired softly (inactive) in a finally. Every number
 * asserted is read back from the API, not from the screen.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { VIEWPORTS, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const QUESTION = "Your stock shows 10. Is that 10 boxes or 10 pieces?";

type Ctx = { api: string; headers: Record<string, string> };

async function createHeldProduct(page: Page, ctx: Ctx, tag: string) {
  const created = await page.request.post(`${ctx.api}/products`, {
    headers: ctx.headers,
    data: { name: `QA Pack Intro ${tag}`, sku: `QAPI${tag}`, unit: "Case", pricePerUnit: "240.00" },
  });
  expect(created.ok(), `create the throwaway product: ${created.status()}`).toBeTruthy();
  const id = ((await created.json()) as any).id as string;
  const bought = await page.request.post(`${ctx.api}/inventory/movements/purchase`, {
    headers: ctx.headers,
    data: { productId: id, quantity: 10, unitCost: 48 },
  });
  expect(bought.ok(), `give it stock: ${bought.status()}`).toBeTruthy();
  return id;
}

async function stored(page: Page, ctx: Ctx, id: string) {
  const res = await page.request.get(`${ctx.api}/products/${id}`, { headers: ctx.headers });
  expect(res.ok(), `read the product: ${res.status()}`).toBeTruthy();
  const p = (await res.json()) as any;
  return {
    pack: p.unitsPerBox == null ? null : Number(p.unitsPerBox),
    stock: Number(p.currentStock),
    cost: Number(p.averageCost),
    price: Number(p.pricePerUnit),
  };
}

async function retire(page: Page, ctx: Ctx, id: string) {
  await page.request.patch(`${ctx.api}/products/${id}`, {
    headers: ctx.headers,
    data: { isActive: false },
  });
}

const saveButton = (page: Page) => page.locator("button:visible", { hasText: /^Save$/ }).first();

/** Opens the editor, types a pack of 24 and saves, which asks. */
async function saveFirstPack(page: Page, id: string) {
  await page.goto(`/products/${id}`);
  await page.getByTitle("Edit product").click();
  await page.getByRole("spinbutton", { name: /per (box|case)/i }).fill("24");
  await saveButton(page).click();
  return page.getByRole("dialog", { name: QUESTION });
}

for (const vp of VIEWPORTS) {
  test.describe(`W-867 first pack @${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test.beforeEach(async ({ context }) => {
      assertTestTenant(TENANT_SLUG, "W-867 pack intro fixtures");
      await setTenantCookie(context, BASE);
    });

    test("closing saves nothing; Boxes converts stock and cost, and no price moves", async ({
      page,
    }, info) => {
      const ctx = await requireUnitsV2Flag(page);
      const id = await createHeldProduct(
        page,
        ctx,
        `${Date.now().toString(36).toUpperCase()}B${vp.name}`,
      );
      try {
        const asked = await saveFirstPack(page, id);
        await expect(asked).toBeVisible({ timeout: 20_000 });
        await expect(
          asked.getByText("Stock will be 240 pieces (10 × 24), and cost is divided by 24."),
        ).toBeVisible();
        await expect(asked.getByText("Stock stays 10 pieces.")).toBeVisible();
        const inView = await page.getByTestId("pack-reading-box").evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        });
        expect(inView, "both answers are on screen").toBe(true);
        await shot(page, info, "w867-question");

        await page.keyboard.press("Escape");
        await expect(asked).toBeHidden();
        expect(await stored(page, ctx, id)).toEqual({
          pack: null,
          stock: 10,
          cost: 48,
          price: 240,
        });

        await saveButton(page).click();
        await expect(asked).toBeVisible({ timeout: 20_000 });
        await page.getByTestId("pack-reading-box").click();
        await expect(asked).toBeHidden();
        await expect
          .poll(() => stored(page, ctx, id))
          .toEqual({ pack: 24, stock: 240, cost: 2, price: 240 });
        await shot(page, info, "w867-after-boxes");
      } finally {
        await retire(page, ctx, id);
      }
    });

    test("Pieces keeps stock and cost, and sets the pack", async ({ page }) => {
      const ctx = await requireUnitsV2Flag(page);
      const id = await createHeldProduct(
        page,
        ctx,
        `${Date.now().toString(36).toUpperCase()}P${vp.name}`,
      );
      try {
        const asked = await saveFirstPack(page, id);
        await expect(asked).toBeVisible({ timeout: 20_000 });
        await page.getByTestId("pack-reading-piece").click();
        await expect(asked).toBeHidden();
        await expect
          .poll(() => stored(page, ctx, id))
          .toEqual({ pack: 24, stock: 10, cost: 48, price: 240 });
      } finally {
        await retire(page, ctx, id);
      }
    });

    test("W-1: a click on the list's MSRP cell stays on the list", async ({ page }) => {
      test.skip(vp.cards, "Quick Edit is a table mode; the phone list has no MSRP cell");
      const ctx = await requireUnitsV2Flag(page);
      const sku = `QAPI${Date.now().toString(36).toUpperCase()}M${vp.name}`;
      const id = await createHeldProduct(page, ctx, sku.slice(4));
      try {
        await page.goto(`/products?search=${encodeURIComponent(sku)}`);
        await page.getByRole("button", { name: "Quick Edit", exact: true }).click();
        await page.waitForLoadState("networkidle");
        await page
          .getByRole("row", { name: new RegExp(sku) })
          .getByTitle("Add msrp")
          .click();

        await expect(page.locator("input[type=number]:focus")).toBeVisible();
        await expect(page).toHaveURL(/\/products\?search=/);
      } finally {
        await retire(page, ctx, id);
      }
    });

    test("the list's quick edit asks the same question", async ({ page }) => {
      test.skip(vp.cards, "Quick Edit is a table mode; the phone list has no pack cell");
      const ctx = await requireUnitsV2Flag(page);
      const sku = `QAPI${Date.now().toString(36).toUpperCase()}L${vp.name}`;
      const id = await createHeldProduct(page, ctx, sku.slice(4));
      try {
        await page.goto(`/products?search=${encodeURIComponent(sku)}`);
        await page.getByRole("button", { name: "Quick Edit", exact: true }).click();
        await page.waitForLoadState("networkidle");
        await page
          .getByRole("row", { name: new RegExp(sku) })
          .getByTitle("Add unitsPerBox")
          .click();
        await page.locator("input[type=number]:focus").fill("24");
        await page.keyboard.press("Enter");

        const asked = page.getByRole("dialog", { name: QUESTION });
        await expect(asked).toBeVisible({ timeout: 20_000 });
        await page.getByTestId("pack-reading-box").click();
        await expect(asked).toBeHidden();
        await expect
          .poll(() => stored(page, ctx, id))
          .toEqual({ pack: 24, stock: 240, cost: 2, price: 240 });
      } finally {
        await retire(page, ctx, id);
      }
    });
  });
}
