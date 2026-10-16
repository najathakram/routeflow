/**
 * Units v2 (units-v2-customer-prices): the product's customer prices load for the planners.
 *   a product with a customer price -> GET /products/:id/customer-prices answers 200 with that customer ->
 *   the product page, in edit mode, requests it (200) -> a Retail edit's "Also update" plan names the customer.
 *
 * LOCAL LANE ONLY (project `units-v2`). Writes on the approved test tenant only (assertTestTenant first): one throwaway
 * product and one throwaway customer holding a typed price on it, retired softly afterwards (inactive, never hard-deleted),
 * like units-v2-blank-tiers-money. Nothing is saved from the page: the edit is cancelled. A tenant not served
 * `flag.units_prices_v2` FAILS the spec.
 */
import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { VIEWPORTS, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const RETAIL = 10;
const CUSTOMER_PRICE = 9;

for (const vp of VIEWPORTS) {
  test.describe(`Units v2 customer prices load @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("the endpoint serves the customer; the product page's edit mode loads it and the plan names them", async ({
      page,
      context,
    }, info) => {
      assertTestTenant(TENANT_SLUG, "units-v2 customer-prices fixtures");
      await setTenantCookie(context, BASE);
      const { api, headers } = await requireUnitsV2Flag(page);
      const tag = `${Date.now().toString(36).toUpperCase()}${vp.name}`;
      const customerName = `QA UV2 CP ${tag}`;
      let productId = "";
      let customerId = "";
      try {
        const prod = await page.request.post(`${api}/products`, {
          headers,
          data: {
            name: `QA UV2 CPrices ${tag}`,
            sku: `QAUV2CP${tag}`,
            unit: "each",
            pricePerUnit: RETAIL.toFixed(2),
          },
        });
        expect(prod.ok(), `create the product: ${prod.status()}`).toBeTruthy();
        productId = ((await prod.json()) as any).id;

        const cust = await page.request.post(`${api}/customers`, {
          headers,
          data: {
            businessName: customerName,
            contactName: "QA UV2",
            username: `qa-uv2-cp-${tag.toLowerCase()}`,
          },
        });
        expect(cust.ok(), `create the customer: ${cust.status()}`).toBeTruthy();
        customerId = ((await cust.json()) as any).customer.id;

        // Give the customer a typed price on the product's anchor unit, the way the page's Save does.
        const gridRes = await page.request.get(`${api}/products/${productId}/price-grid`, {
          headers,
        });
        expect(gridRes.ok(), `GET price-grid returned ${gridRes.status()}`).toBe(true);
        const grid: any = await gridRes.json();
        const ref: string = grid.anchor;
        const saved = await page.request.post(`${api}/products/${productId}/prices`, {
          headers,
          data: {
            expectedRevision: grid.revision,
            expectedPriceState: grid.priceState,
            patches: [],
            customerMoves: [{ customerId, ref, tier: 1, from: null, to: CUSTOMER_PRICE }],
          },
        });
        expect(saved.ok(), `POST prices (a customer price) returned ${saved.status()}`).toBe(true);

        // The route exists (it used to be a 404 before auth) and serves the customer.
        const res = await page.request.get(`${api}/products/${productId}/customer-prices`, {
          headers,
        });
        expect(res.status(), "GET customer-prices").toBe(200);
        const body: any = await res.json();
        const fresh: any = await (
          await page.request.get(`${api}/products/${productId}/price-grid`, { headers })
        ).json();
        expect(body.productId).toBe(productId);
        expect(body.revision, "the same revision price-grid answers").toBe(fresh.revision);
        expect(body.truncated).toBe(false);
        expect(body.customers).toEqual([
          expect.objectContaining({
            customerId,
            name: customerName,
            tier: 1,
            orderUnit: null,
            set: { [ref]: CUSTOMER_PRICE },
          }),
        ]);

        // The page: edit mode asks for it (200), and a Retail edit's plan names the customer.
        await page.goto(`/products/${productId}`);
        const loaded = page.waitForResponse(
          (r) => r.url().includes(`/products/${productId}/customer-prices`) && r.status() === 200,
        );
        await page.getByTestId("units-v2-btn-edit").click();
        await loaded;
        const input = page.locator(`[data-testid="units-v2-input-${ref}-1"]:visible`).first();
        await expect(input).toBeVisible({ timeout: 20_000 });
        await input.fill((RETAIL + 1).toFixed(2));
        const plan = page.getByTestId("units-v2-cell-plan");
        await expect(plan).toBeVisible();
        await expect(plan.getByText(customerName).first()).toBeVisible();
        await shot(page, info, "customer-prices-plan");
      } finally {
        // Cleanup must never hide the test's own failure: report a failed retire, do not assert on it.
        if (productId) {
          const r = await page.request.patch(`${api}/products/${productId}`, {
            headers,
            data: { isActive: false },
          });
          // eslint-disable-next-line no-console
          if (!r.ok()) console.warn(`could not retire the throwaway product: ${r.status()}`);
        }
        if (customerId) {
          const r = await page.request.patch(`${api}/customers/${customerId}/status`, {
            headers,
            data: { status: "INACTIVE" },
          });
          // eslint-disable-next-line no-console
          if (!r.ok()) console.warn(`could not retire the throwaway customer: ${r.status()}`);
        }
      }
    });
  });
}
