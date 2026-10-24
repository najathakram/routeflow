/**
 * K11-28 (F06): Sam's new-product job ends with a $1.75 Piece price in seven steps, at 1440 / 768 / 390.
 *   open New Product, Name, Unit, Price per case, Units per box, Price per piece, Create -> the product page's
 *   grid shows a Piece row with Retail $1.75 set by hand, and the product's price revision is 1 (exactly one S9
 *   write; the units POST carries no price and bumps nothing). The PRODUCT_PRICES_SAVED audit row is that one write.
 *
 * LOCAL LANE ONLY (project `units-v2`). WRITES one throwaway product on the approved test tenant only
 * (assertTestTenant first), retired softly (inactive) in finally. `flag.units_prices_v2` AND `flag.units_v1` must be
 * served: a tenant without them FAILS the spec.
 */
import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { VIEWPORTS, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";

for (const vp of VIEWPORTS) {
  test.describe(`K11-28 piece price @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("k11-l3 a cased product is created with a $1.75 Piece price", async ({
      page,
      context,
    }, info) => {
      assertTestTenant(TENANT_SLUG, "k11-28 piece-price fixtures");
      await setTenantCookie(context, BASE);
      const ctx = await requireUnitsV2Flag(page);
      const sub = await page.request.get(`${ctx.api}/billing/subscription`, {
        headers: ctx.headers,
      });
      expect(((await sub.json()) as any).flags, "flag.units_v1 is served").toContain(
        "flag.units_v1",
      );
      const name = `QA K11 Piece ${Date.now().toString(36).toUpperCase()}${vp.name}`;
      let productId = "";
      try {
        await page.goto("/products");
        await page.getByRole("button", { name: "New Product", exact: true }).click(); // 1
        const dialog = page.getByRole("dialog", { name: "New product" });
        await dialog.getByLabel("Name *", { exact: true }).fill(name); // 2
        await dialog.getByLabel(/^Unit \*/).fill("case"); // 3
        await dialog.getByLabel(/^Price per case/).fill("21"); // 4
        await dialog.getByLabel("Units per box").fill("12"); // 5
        const piece = dialog.getByLabel(/^Price per piece/);
        await expect(piece).toBeVisible();
        await piece.fill("1.75"); // 6
        // 390: scrolled to it, the field AND its helper end above the pinned footer.
        if (vp.width < 640) {
          await piece.scrollIntoViewIfNeeded();
          const helper = dialog.getByText(/^Leave blank to sell only by the/);
          const footer = (await dialog
            .getByRole("button", { name: "Create product" })
            .boundingBox())!;
          const p = (await piece.boundingBox())!;
          const h = (await helper.boundingBox())!;
          expect(p.y + p.height, "the field ends above the footer").toBeLessThan(footer.y);
          expect(h.y + h.height, "the helper ends above the footer").toBeLessThan(footer.y);
        }
        await shot(page, info, "k11-28-new-product-piece");
        await dialog.getByRole("button", { name: "Create product" }).click(); // 7
        await expect(
          page
            .getByRole("status")
            .filter({ hasText: `${name} created` })
            .first(),
        ).toBeVisible({ timeout: 10_000 });

        const list = await page.request.get(`${ctx.api}/products`, {
          headers: ctx.headers,
          params: { search: name, limit: "10" },
        });
        productId = (((await list.json()) as any).data ?? [])[0]?.id ?? "";
        expect(productId, "the product was created").toBeTruthy();

        const gridRes = await page.request.get(`${ctx.api}/products/${productId}/price-grid`, {
          headers: ctx.headers,
        });
        const grid: any = await gridRes.json();
        const pieceRow = grid.rows.find((r: any) => r.ref === "base");
        const retail = pieceRow.cells.find((c: any) => c.tier === 1);
        expect(retail.source, "Retail was set by hand").toBe("set");
        expect(Number(retail.value)).toBe(1.75);
        expect(grid.revision, "exactly one S9 price write").toBe(1);

        await page.goto(`/products/${productId}`);
        await expect(page.getByTestId("units-v2-grid")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId("units-v2-grid")).toContainText("$1.75");
        await shot(page, info, "k11-28-piece-in-grid");
      } finally {
        if (productId) {
          const r = await page.request.patch(`${ctx.api}/products/${productId}`, {
            headers: ctx.headers,
            data: { isActive: false },
          });
          expect(r.ok(), `retire the throwaway product: ${r.status()}`).toBeTruthy();
        }
      }
    });
  });
}
