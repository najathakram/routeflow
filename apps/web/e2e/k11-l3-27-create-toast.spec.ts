/**
 * K11-27 (F27): Create says it worked, every time, at 1440 / 768 / 390.
 *   "Add variant" (from a parent's card) with only the flavor typed creates the variant and a role=status toast
 *   "{Flavor} added to {Parent}" is still visible 3 s later. "New product" says "{Name} created". A double-click
 *   makes one product and one toast (B1244).
 *
 * LOCAL LANE ONLY (project `units-v2`). WRITES on the approved test tenant only (assertTestTenant first): one
 * throwaway parent with one variant (over the API), then the products the UI creates. Every one is retired softly
 * in finally (inactive, never hard-deleted), like units-v2-blank-tiers-money.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { VIEWPORTS, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";

type Ctx = { api: string; headers: Record<string, string> };

async function idsBySearch(page: Page, ctx: Ctx, search: string): Promise<string[]> {
  const res = await page.request.get(`${ctx.api}/products`, {
    headers: ctx.headers,
    params: { search, limit: "50" },
  });
  expect(res.ok(), `GET /products?search returned ${res.status()}`).toBe(true);
  return (((await res.json()) as any)?.data ?? []).map((p: any) => p.id as string);
}

async function retire(page: Page, ctx: Ctx, ids: string[]) {
  for (const id of ids) {
    const r = await page.request.patch(`${ctx.api}/products/${id}`, {
      headers: ctx.headers,
      data: { isActive: false },
    });
    expect(r.ok(), `retire the throwaway product: ${r.status()}`).toBeTruthy();
  }
}

for (const vp of VIEWPORTS) {
  test.describe(`K11-27 create toast @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("k11-l3 add variant and new product each show a toast; a double-click makes one product", async ({
      page,
      context,
    }, info) => {
      assertTestTenant(TENANT_SLUG, "k11-27 create-toast fixtures");
      await setTenantCookie(context, BASE);
      const ctx = await requireUnitsV2Flag(page);
      const tag = `${Date.now().toString(36).toUpperCase()}${vp.name}`;
      const parentName = `QA K11 Parent ${tag}`;
      const flavor = `Strawberry ${tag}`;
      const standalone = `QA K11 Cola ${tag}`;
      try {
        const parent = await page.request.post(`${ctx.api}/products`, {
          headers: ctx.headers,
          data: { name: parentName, sku: `QAK11P${tag}`, unit: "each", pricePerUnit: "2.50" },
        });
        expect(parent.ok(), `create the parent: ${parent.status()}`).toBeTruthy();
        const parentId = ((await parent.json()) as any).id as string;
        const seed = await page.request.post(`${ctx.api}/products`, {
          headers: ctx.headers,
          data: {
            name: `Seed ${tag}`,
            variantName: `Seed ${tag}`,
            parentProductId: parentId,
            sku: `QAK11S${tag}`,
            unit: "each",
            pricePerUnit: "2.50",
          },
        });
        expect(seed.ok(), `create the first variant: ${seed.status()}`).toBeTruthy();

        // 1. Add variant, only the flavor typed.
        await page.goto("/products");
        await page
          .getByPlaceholder(/search/i)
          .first()
          .fill(parentName);
        await page.getByRole("button", { name: "Add variant" }).first().click({ timeout: 15_000 });
        const dialog = page.getByRole("dialog", { name: "New product" });
        await expect(dialog).toBeVisible();
        await dialog.getByPlaceholder(/Chocolate/).fill(flavor);
        await dialog.getByRole("button", { name: "Create product" }).click();
        await page.waitForTimeout(3_000);
        await expect(
          page
            .getByRole("status")
            .filter({ hasText: `${flavor} added to ${parentName}` })
            .first(),
        ).toBeVisible();
        await shot(page, info, "k11-27-add-variant-toast");

        // 2. New product, double-clicked: one product, one toast.
        await page.getByRole("button", { name: "New Product", exact: true }).click();
        const dlg2 = page.getByRole("dialog", { name: "New product" });
        await dlg2.getByLabel("Name *", { exact: true }).fill(standalone);
        await dlg2.getByLabel(/^Unit \*/).fill("each");
        await dlg2.getByLabel(/^Price per/).fill("3.00");
        await dlg2.getByRole("button", { name: "Create product" }).dblclick();
        await page.waitForTimeout(3_000);
        await expect(
          page.getByRole("status").filter({ hasText: `${standalone} created` }),
        ).toHaveCount(1);
        expect(await idsBySearch(page, ctx, standalone)).toHaveLength(1);
      } finally {
        await retire(page, ctx, [
          ...(await idsBySearch(page, ctx, `QA K11 Parent ${tag}`)),
          ...(await idsBySearch(page, ctx, flavor)),
          ...(await idsBySearch(page, ctx, `Seed ${tag}`)),
          ...(await idsBySearch(page, ctx, standalone)),
        ]);
      }
    });
  });
}
