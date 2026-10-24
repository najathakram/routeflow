/**
 * Units v2 (units-v2-blank-tiers-money): with `flag.units_prices_v2` on, a product created with BLANK tier prices bills
 * a Tier 2 customer at the Retail price - on the ORDER line and on the INVOICE line (unit price and subtotal both equal Retail).
 *
 * LOCAL LANE ONLY (project `units-v2`). Writes on the approved test tenant only (assertTestTenant first): one throwaway
 * product (Retail 10.00, tiers left blank), one throwaway Tier 2 customer, one PENDING order and its invoice. The product and
 * customer are retired softly in afterAll (inactive, never hard-deleted), like spec 72; neither order nor invoice has an API delete.
 * A tenant not served `flag.units_prices_v2` FAILS the spec.
 */
import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { VIEWPORTS, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
const RETAIL = 10;
const QTY = 2;

for (const vp of VIEWPORTS) {
  test.describe(`Units v2 blank tiers bill Retail @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("Tier 2 customer: order line and invoice line equal Retail", async ({
      page,
      context,
    }, info) => {
      assertTestTenant(TENANT_SLUG, "units-v2 blank-tiers money fixtures");
      await setTenantCookie(context, BASE);
      const { api, headers } = await requireUnitsV2Flag(page);
      const tag = `${Date.now().toString(36).toUpperCase()}${vp.name}`;
      let productId = "";
      let customerId = "";
      try {
        const prod = await page.request.post(`${api}/products`, {
          headers,
          data: {
            name: `QA UV2 Blank ${tag}`,
            sku: `QAUV2${tag}`,
            unit: "each",
            pricePerUnit: RETAIL.toFixed(2), // tier prices deliberately omitted (blank)
          },
        });
        expect(prod.ok(), `create the blank-tier product: ${prod.status()}`).toBeTruthy();
        productId = ((await prod.json()) as any).id;

        const cust = await page.request.post(`${api}/customers`, {
          headers,
          data: {
            businessName: `QA UV2 Tier2 ${tag}`,
            contactName: "QA UV2",
            username: `qa-uv2-${tag.toLowerCase()}`,
            pricingTier: 2,
          },
        });
        expect(cust.ok(), `create the Tier 2 customer: ${cust.status()}`).toBeTruthy();
        customerId = ((await cust.json()) as any).customer.id;

        const orderRes = await page.request.post(`${api}/orders`, {
          headers,
          data: { customerId, status: "PENDING", forceNew: true, items: [{ productId, qty: QTY }] },
        });
        expect(orderRes.ok(), `POST /orders returned ${orderRes.status()}`).toBe(true);
        const created: any = await orderRes.json();
        const order: any = await (
          await page.request.get(`${api}/orders/${created.id}`, { headers })
        ).json();
        const oLine = order.lineItems.find((l: any) => l.productId === productId);
        expect(oLine, "order carries the throwaway product line").toBeTruthy();
        expect(Number(oLine.unitPrice), "order line unit price is Retail").toBe(RETAIL);
        expect(Number(oLine.subtotal), "order line total is qty x Retail").toBe(RETAIL * QTY);
        expect(Number(order.subtotal), "order subtotal is qty x Retail").toBe(RETAIL * QTY);

        const invRes = await page.request.post(`${api}/invoices/from-order/${created.id}`, {
          headers,
        });
        expect(invRes.ok(), `POST /invoices/from-order returned ${invRes.status()}`).toBe(true);
        const invBody: any = await invRes.json();
        const inv0 = (Array.isArray(invBody) ? invBody : [invBody])[0];
        const invoice: any = await (
          await page.request.get(`${api}/invoices/${inv0.id}`, { headers })
        ).json();
        const iLine = invoice.items.find((l: any) => l.productId === productId);
        expect(iLine, "invoice carries the throwaway product line").toBeTruthy();
        expect(Number(iLine.unitPrice), "invoice line unit price is Retail").toBe(RETAIL);
        expect(Number(iLine.subtotal ?? iLine.total), "invoice line total is qty x Retail").toBe(
          RETAIL * QTY,
        );
        expect(Number(invoice.subtotal), "invoice subtotal is qty x Retail").toBe(RETAIL * QTY);

        await page.goto(`/invoices/${inv0.id}`);
        await expect(page.getByText(/10\.00/).first()).toBeVisible({ timeout: 20_000 });
        await shot(page, info, "blank-tiers-invoice");
      } finally {
        if (productId) {
          const r = await page.request.patch(`${api}/products/${productId}`, {
            headers,
            data: { isActive: false },
          });
          expect(r.ok(), `retire the throwaway product: ${r.status()}`).toBeTruthy();
        }
        if (customerId) {
          const r = await page.request.patch(`${api}/customers/${customerId}/status`, {
            headers,
            data: { status: "INACTIVE" },
          });
          expect(r.ok(), `retire the throwaway customer: ${r.status()}`).toBeTruthy();
        }
      }
    });
  });
}
