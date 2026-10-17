/**
 * K11-25 (F24, P21, P23): the family page, at 1440 / 768 / 390.
 *   Variants sits directly under Details (within two screens of the top at 390, was about six); a family that was
 *   never sold shows ONE "Never sold" with the true second line and no create-order link; the family price is a
 *   collapsed "Family price $x" disclosure that Edit opens, with the same inputs inside.
 *
 * LOCAL LANE ONLY (project `units-v2`). READ-ONLY (Edit is cancelled). The family is discovered or self-provisioned
 * on the approved test tenant. A family with sales history is not provisioned here, so the single-empty-state
 * claim is only asserted when the page shows "Never sold".
 */
import { test, expect } from "@playwright/test";
import { VIEWPORTS, ensureFamily, pageTopOf, shot, viewportHeight } from "./k11-l3-support";
import { setTenantCookie } from "./helpers/auth";
import { requireUnitsV2Flag } from "./helpers/units-v2-support";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";

for (const vp of VIEWPORTS) {
  test.describe(`K11-25 family page @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("k11-l3 variants first, one empty state, family price disclosure", async ({
      page,
      context,
    }, info) => {
      await setTenantCookie(context, BASE);
      const ctx = await requireUnitsV2Flag(page);
      const family = await ensureFamily(page, ctx);
      await page.goto(`/products/${family.id}`);
      const details = page
        .locator("div.overflow-hidden", {
          has: page.getByRole("heading", { name: "Details", exact: true }),
        })
        .first();
      await expect(details).toBeVisible({ timeout: 20_000 });

      // Variants: the very next card after Details, and near the top of the page.
      const variants = page.getByRole("heading", { name: /^Variants/ }).first();
      await expect(variants).toBeVisible();
      const top = await pageTopOf(variants);
      expect(top, "Variants is within two screens of the top").toBeLessThanOrEqual(
        2 * viewportHeight(page),
      );
      const d = (await details.boundingBox())!;
      expect(top, "Variants comes after Details").toBeGreaterThan(d.y);

      // One empty state, with the true copy and no create-order link.
      if ((await page.getByText("Never sold", { exact: true }).count()) > 0) {
        await expect(page.getByText("Never sold", { exact: true })).toHaveCount(1);
        await expect(
          page.getByText("A family isn't sold itself. Each variant's sales are on its own page."),
        ).toBeVisible();
      }
      await expect(page.getByText(/Create an order with this product/)).toHaveCount(0);
      await expect(page.locator("#h-sales")).toHaveCount(1);

      // The family price: a collapsed disclosure with its value, opened by Edit.
      await expect(page.getByText("New variants start from the family price.")).toBeVisible();
      const disclosure = page.getByRole("button", { name: /^Family price \$/ });
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await disclosure.click();
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await expect(details.getByText("Pricing Tiers")).toBeVisible();
      await disclosure.click();
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await shot(page, info, "k11-25-family-page");

      await page.getByTitle("Edit product").click();
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await expect(details.getByRole("button", { name: /Set all to/ })).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
    });
  });
}
