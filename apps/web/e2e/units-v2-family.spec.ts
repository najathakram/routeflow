/**
 * Units v2 (units-v2-family): a FAMILY product (a parent that has variants) cannot be sold.
 *   header "Family. Can't be sold. Choose a variant." -> no v2 grid -> no old units card
 *   -> the Never sold state has no "Create an order with this product" link.
 *
 * LOCAL LANE ONLY (project `units-v2`). Read-only. The family is DISCOVERED over the API (an active product with no parent and
 * at least one variant); a tenant with none is a FAILURE naming what to seed, never a skip. A tenant not served
 * `flag.units_prices_v2` FAILS the spec.
 */
import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { UNITS_V2_IDS } from "./helpers/units-v2-ids";
import { VIEWPORTS, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";

for (const vp of VIEWPORTS) {
  test.describe(`Units v2 family @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("family header, no grid, no old units card, no create-order link", async ({
      page,
      context,
    }, info) => {
      await setTenantCookie(context, BASE);
      const ctx = await requireUnitsV2Flag(page);
      const res = await page.request.get(`${ctx.api}/products`, {
        headers: ctx.headers,
        params: { limit: "200" },
      });
      expect(res.ok(), `GET /products returned ${res.status()}`).toBe(true);
      const rows: any[] = ((await res.json()) as any)?.data ?? [];
      const family = rows.find(
        (p) => p?.isActive !== false && !p.parentProductId && (p.variants?.length ?? 0) > 0,
      );
      expect(
        family,
        "No active family product (a parent with variants) on this tenant - seed one on the test tenant and re-run.",
      ).toBeTruthy();

      await page.goto(`/products/${family.id}`);
      const header = page.getByTestId(UNITS_V2_IDS.familyHeader);
      await expect(header).toBeVisible({ timeout: 20_000 });
      await expect(header).toContainText("Family. Can't be sold. Choose a variant.");

      await expect(page.getByTestId(UNITS_V2_IDS.grid)).toHaveCount(0);
      await expect(page.getByRole("heading", { name: /^Units$/ })).toHaveCount(0);
      await expect(page.getByText("Never sold").first()).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Create an order with this product" }),
      ).toHaveCount(0);
      await shot(page, info, "family");
    });
  });
}
