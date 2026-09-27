/**
 * B743 PR B — the web bill page turns the API's PACK_SIZE_UNKNOWN 409 into an explicit choice.
 *
 * The server gate is DARK (it logs and always allows), so the 409 never fires live yet. This
 * spec proves the UI by answering the FIRST receive with the 409 through `page.route`, per the
 * lead's ruling (no compose flip). It checks:
 *   - the dialog lists the flagged line and spells out the loose-pieces consequence;
 *   - "Receive as loose pieces" resends WITH acknowledgePackSizeUnknown (the second request,
 *     also answered by the mock, so nothing is written);
 *   - it renders at 390 / 768 / 1440 (a screenshot per viewport).
 *
 * Role: OPERATOR (pre-authenticated storageState). Tenant: the approved e2e-routeflow seed.
 * Fixtures are self-provisioned through the API and addressed only by the ids it returns.
 * Needs the full stack (a signed-in session), so it runs on a host with a compose slot or
 * against a deployed target, never on a host without a container runtime.
 */
import { test, expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "https://routeflowweb-production.up.railway.app";
const CONSEQUENCE = "Stock counts each as 1 piece; cost is per piece.";

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
] as const;

async function apiHeaders(page: Page) {
  const token = await operatorAccessToken(page);
  return token ? { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG } : null;
}

test.describe("Vendor bill: missing units per case is an explicit choice (B743)", () => {
  test.beforeEach(async ({ context }) => {
    await setTenantCookie(context, BASE);
  });

  for (const vp of VIEWPORTS) {
    test(`REG-B743-web @${vp.name}: the 409 opens the dialog; loose pieces resends with the acknowledgement`, async ({
      page,
      request,
    }, testInfo) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/vendor-bills");
      const headers = await apiHeaders(page);
      expect(headers, "no operator access token — storageState is stale").toBeTruthy();
      const api = apiBase(page.url());
      const suffix = `${Date.now()}-${vp.name}`;

      const supplier = await (
        await request.post(`${api}/api/v1/suppliers`, {
          headers: headers!,
          data: { name: `E2E B743 Supplier ${suffix}` },
        })
      ).json();
      const product = await (
        await request.post(`${api}/api/v1/products`, {
          headers: headers!,
          data: { name: `E2E B743 Product ${suffix}`, unit: "unit", pricePerUnit: "20.00" },
        })
      ).json();
      const billRes = await request.post(`${api}/api/v1/vendor-bills`, {
        headers: headers!,
        data: {
          supplierId: supplier.id,
          billDate: new Date().toISOString().slice(0, 10),
          items: [{ productId: product.id, description: product.name, qty: 2, unitCost: 30 }],
        },
      });
      expect(billRes.ok(), `POST /vendor-bills returned ${billRes.status()}`).toBe(true);
      const bill: { id: string } = await billRes.json();

      // First receive → the 409; every later receive is recorded and answered as a success.
      const receiveBodies: Array<Record<string, unknown>> = [];
      await page.route(`**/api/v1/vendor-bills/${bill.id}/receive`, async (route) => {
        receiveBodies.push(route.request().postDataJSON() ?? {});
        if (receiveBodies.length === 1) {
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              code: "PACK_SIZE_UNKNOWN",
              message: `"${product.name}" doesn't state units per case, and this product is normally sold by the case — confirm before it's recorded as loose pieces.`,
              packSizeUnknownItems: [
                {
                  id: "mock-line",
                  lineIndex: 0,
                  description: product.name,
                  productId: product.id,
                  productName: product.name,
                  qty: 2,
                  unitCost: 30,
                  productPack: 12,
                },
              ],
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ id: bill.id, status: "RECEIVED", gapsDetected: [] }),
        });
      });

      await page.goto(`/vendor-bills/${bill.id}`);
      await page.getByRole("button", { name: "Mark Received" }).first().click();
      await page.getByTestId("receive-confirm").click();

      const dialog = page.getByRole("dialog", { name: "Units per case missing" });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("list", { name: "Lines missing units per case" }),
      ).toContainText(product.name);
      await expect(dialog.getByTestId("loose-pieces-consequence")).toContainText(CONSEQUENCE);
      await page.screenshot({ path: testInfo.outputPath(`b743-dialog-${vp.name}.png`) });

      // The first attempt never acknowledged the pack on its own.
      expect(receiveBodies[0]?.acknowledgePackSizeUnknown).toBeUndefined();

      await dialog.getByRole("button", { name: "Receive as loose pieces" }).click();
      await expect(dialog).toBeHidden();
      expect(receiveBodies).toHaveLength(2);
      expect(receiveBodies[1]?.acknowledgePackSizeUnknown).toBe(true);
    });
  }
});
