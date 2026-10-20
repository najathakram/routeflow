/**
 * K11-27 (F27): Create says it worked, every time, at 1440 / 768 / 390.
 *   "Add variant" (from a family's row) with only the flavor typed creates the variant and a toast
 *   "{Flavor} added to {Family}" is still visible 3 s later. "New product" says "{Name} created". A double-click
 *   makes one product and one toast (B1244).
 *
 * The toast is located as a listitem of the Notifications region. Radix gives role="status" only to a transient
 * screen-reader announcer that it removes after 1 s; the visible toast has no role, so getByRole("status") would
 * stop matching at ~1 s while the toast is still up.
 *
 * LOCAL LANE ONLY (project `units-v2`). WRITES on the approved test tenant only (assertTestTenant first): one
 * throwaway FAMILY with two variants that this spec makes itself over the API (never the shared "E2E Fixture
 * Family"), the variant the UI adds to it, and one standalone product. Everything is retired softly (inactive) in
 * finally; a failed retire is logged, not asserted.
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

/** Soft retire: log a failure, never assert (cleanup must not mask the test's own result). */
async function retire(page: Page, ctx: Ctx, ids: string[]) {
  for (const id of ids) {
    try {
      const r = await page.request.patch(`${ctx.api}/products/${id}`, {
        headers: ctx.headers,
        data: { isActive: false },
      });
      if (!r.ok()) console.warn(`k11-27: could not retire ${id}: ${r.status()}`);
    } catch (e) {
      console.warn(`k11-27: could not retire ${id}: ${String(e)}`);
    }
  }
}

/** The visible toasts with this text (see the file header on why not role=status). */
const toasts = (page: Page, text: string) =>
  page
    .getByRole("region", { name: /Notifications/ })
    .getByRole("listitem")
    .filter({ hasText: text });

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
      const familyName = `QA K11 Family ${tag}`;
      const flavor = `Strawberry ${tag}`;
      const standalone = `QA K11 Cola ${tag}`;
      try {
        // A throwaway family of our own, over the API.
        const made = await page.request.post(`${ctx.api}/products/families`, {
          headers: ctx.headers,
          data: {
            family: { name: familyName, pricePerUnit: "2.50" },
            variants: [
              { name: `Seed A ${tag}`, sku: `QAK11A${tag}`, pricePerUnit: "2.50" },
              { name: `Seed B ${tag}`, sku: `QAK11B${tag}`, pricePerUnit: "2.60" },
            ],
          },
        });
        expect(made.ok(), `create the throwaway family: ${made.status()}`).toBeTruthy();

        // 1. Add variant on OUR family's row, only the flavor typed.
        await page.goto("/products");
        await page.getByPlaceholder("Name, SKU or scan barcode…").fill(familyName);
        // wait for the list to be filtered to our family before touching any row
        const familyLink = page.getByRole("link", { name: familyName });
        await expect(familyLink).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole("button", { name: "Add variant" })).toHaveCount(1, {
          timeout: 15_000,
        });
        const row = familyLink.locator(
          "xpath=ancestor::div[.//button[normalize-space()='Add variant']][1]",
        );
        await row.getByRole("button", { name: "Add variant" }).click();
        const dialog = page.getByRole("dialog", { name: "New product" });
        await expect(dialog).toBeVisible();
        await dialog.getByPlaceholder(/Chocolate/).fill(flavor);
        await dialog.getByRole("button", { name: "Create product" }).click();
        await page.waitForTimeout(3_000);
        await expect(toasts(page, `${flavor} added to ${familyName}`)).toHaveCount(1);
        await shot(page, info, "k11-27-add-variant-toast");
        // K12 F07: Create from the list opens the new product's page.
        await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}/);

        // 2. New product, double-clicked: one product, one toast.
        await page.goto("/products");
        await page.getByRole("button", { name: "New Product", exact: true }).click();
        const dlg2 = page.getByRole("dialog", { name: "New product" });
        await dlg2.getByLabel("Name *", { exact: true }).fill(standalone);
        await dlg2.getByLabel(/^Unit \*/).fill("each");
        await dlg2.getByLabel(/^Price per/).fill("3.00");
        await dlg2.getByRole("button", { name: "Create product" }).dblclick();
        await page.waitForTimeout(3_000);
        await expect(toasts(page, `${standalone} created`)).toHaveCount(1);
        expect(await idsBySearch(page, ctx, standalone)).toHaveLength(1);
        // K12 F07: the one product it made is the page that opened.
        const [madeId] = await idsBySearch(page, ctx, standalone);
        await expect(page).toHaveURL(new RegExp(`/products/${madeId}`));
      } finally {
        await retire(page, ctx, [
          ...(await idsBySearch(page, ctx, flavor)),
          ...(await idsBySearch(page, ctx, `Seed A ${tag}`)),
          ...(await idsBySearch(page, ctx, `Seed B ${tag}`)),
          ...(await idsBySearch(page, ctx, standalone)),
          ...(await idsBySearch(page, ctx, familyName)),
        ]);
      }
    });
  });
}
