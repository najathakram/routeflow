/**
 * SA-1082 (supersedes K11-11): the Piece row of a product with no 1-piece unit shows its Auto figures and takes a price.
 * The first price creates the unit, and Undo takes it back while nothing else uses it.
 *
 * LOCAL LANE ONLY (project `units-v2`), on the approved test tenant. Fixture product E2E-FIX-CASEDEFAULT has no 1-piece
 * unit (apps/api/scripts/e2e-seed.js ensureUnitsFixture); the test leaves it that way.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { k11BaseUrl } from "./helpers/k11-l2-a-base";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const SKU = "E2E-FIX-CASEDEFAULT";
const visible = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]:visible`);

for (const vp of VIEWPORTS) {
  test.describe(`SA-1082 Piece row @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("Auto figures, then a first price creates the unit, then Undo takes it back", async ({
      page,
      context,
    }, info) => {
      await setTenantCookie(context, k11BaseUrl());
      const ctx = await requireUnitsV2Flag(page);
      const product = await productBySku(page, ctx, SKU);
      const pieces = async () => {
        const res = await page.request.get(`${ctx.api}/products/${product.id}/units`, {
          headers: ctx.headers,
        });
        const units: Array<{ id: string; factorToBase: number; price: unknown }> = await res.json();
        return units.filter((u) => u.factorToBase === 1);
      };
      expect(await pieces(), `${SKU} must have no 1-piece unit`).toEqual([]);
      try {
        await page.goto(`/products/${product.id}`);
        await expect(page.getByTestId("units-v2-grid")).toBeVisible({ timeout: 20_000 });

        const row = visible(page, vp.cards ? "units-v2-card-base" : "units-v2-row-base");
        await expect(row).toHaveCount(1);
        await expect(row).toContainText("$");
        await expect(row).toContainText("Auto");
        await expect(row).not.toContainText("Add Piece unit");
        await shot(page, info, "sa-1082-piece-auto");

        await page.getByTestId("units-v2-btn-edit").click();
        await visible(page, "units-v2-input-base-1").fill("3.00");
        await shot(page, info, "sa-1082-piece-typed");
        const saved = page.waitForResponse(
          (r) =>
            r.url().endsWith(`/products/${product.id}/prices`) && r.request().method() === "POST",
        );
        await page.getByTestId("units-v2-eb-save").click();
        expect((await saved).status(), "the first price was accepted").toBeLessThan(300);
        await expect(row).toContainText("$3.00");
        await expect(row).toContainText("Set");
        const created = await pieces();
        expect(created).toHaveLength(1);
        expect(Number(created[0].price)).toBe(3);
        await shot(page, info, "sa-1082-piece-saved");

        const undone = page.waitForResponse(
          (r) => r.url().endsWith(`/products/${product.id}/prices/undo`) && r.status() < 300,
        );
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await undone;
        await expect.poll(pieces).toEqual([]);
        await expect(row).toContainText("Auto");
        await shot(page, info, "sa-1082-piece-undone");
      } finally {
        for (const u of await pieces().catch(() => [])) {
          await page.request.delete(`${ctx.api}/products/${product.id}/units/${u.id}`, {
            headers: ctx.headers,
          });
        }
      }
    });
  });
}
