/**
 * B1210 (71): the counter sale's "Ship this order instead" carries the cart over.
 *   scan 2 products -> pick a customer -> Ship this order instead
 *   -> the order builder opens on the parked draft: the same 2 lines, the customer, and "Ship via carrier" on.
 * At 1440 / 768 / 390 px, on two profiles:
 *   - pickup_ship (ship-only: PICKUP + SHIP, so ONE form method): the builder resumes the draft with fulfillPath SHIP and shows NO
 *     Fulfillment picker (there is no choice to make, so no picker and no "Ships via carrier." note).
 *   - delivery + ship with the counter on (ROUTE + SHIP): the picker is shown with "Ship via carrier" selected, and the note.
 *
 * LOCAL LANE ONLY. The spec puts the tenant on the in_store_shipping_retailer profile itself (super-admin, via
 * helpers/local-fulfilment-profile.ts) and, in afterAll (also after a failure), restores the tenant's previous fulfilment
 * config row-for-row. Every write is behind assertLocalFulfilmentTarget (localhost + local DB + approved test tenant +
 * not GitHub Actions); playwright.config.ts also registers this project only for a local run. Needs `npm run local:sa`.
 *
 * Role: OPERATOR (pre-authed), on an approved test tenant. The two products and the customer are DISCOVERED over the API (active products with an exact
 * SKU; the first customer), so no fixture is needed beyond the standard seed. Nothing is sold: the hand-off parks an
 * ORDER draft, which this spec deletes through the API at the end. A tenant without the counter, or without the
 * Ship button, is a FAILURE (a skipped spec hides a broken flow), never a skip.
 */
import { test, expect } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { TENANT_SLUG } from "./helpers/constants";
import { apiBase, operatorAccessToken } from "./helpers/api";
import {
  applyBusinessProfile,
  applyDeliveryShipCounter,
  localTarget,
  readApiCapability,
  restoreFulfilmentConfig,
  snapshotFulfilmentConfig,
  type FulfilmentSnapshot,
  waitForApiCapability,
} from "./helpers/local-fulfilment-profile";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
] as const;

const target = () => localTarget(apiBase(BASE));

type Profile = "pickup_ship" | "delivery_ship";
const PROFILES: { key: Profile; label: string }[] = [
  { key: "pickup_ship", label: "ship-only account (pickup + ship)" },
  { key: "delivery_ship", label: "delivery + ship account" },
];

for (const profile of PROFILES) {
  test.describe(`B1210 counter -> ship hand-off, ${profile.label}`, () => {
    let before: FulfilmentSnapshot | null = null;
    let capabilityBefore: unknown = null;

    test.beforeAll(async () => {
      before = await snapshotFulfilmentConfig(target()); // read first: nothing is written until this succeeds
      capabilityBefore = await readApiCapability(target()); // what the API reports before the spec touches anything
      if (profile.key === "pickup_ship") {
        await applyBusinessProfile(target(), before, "in_store_shipping_retailer");
      } else {
        await applyDeliveryShipCounter(target(), before);
      }
    });

    test.afterAll(async () => {
      test.setTimeout(120_000); // the capability poll below may take up to 60 s
      if (!before) return;
      const restored = await restoreFulfilmentConfig(target(), before);
      expect(restored, "the tenant's fulfilment config is back exactly as it was").toBe(true);
      // The API caches modes for a short time: wait until IT reads the pre-run state back (fails loudly with observed vs expected).
      await waitForApiCapability(target(), capabilityBefore, 60_000);
    });

    for (const vp of VIEWPORTS) {
      test.describe(`@ ${vp.name}`, () => {
        test.use({ viewport: { width: vp.width, height: vp.height } });

        test("scan 2 -> Ship this order instead -> the builder resumes the draft as SHIP", async ({
          page,
          context,
        }) => {
          await setTenantCookie(context, BASE);
          await page.goto("/orders");
          const token = await operatorAccessToken(page);
          const api = `${apiBase(page.url())}/api/v1`;
          const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };

          const prodRes = await page.request.get(`${api}/products`, {
            headers,
            params: { limit: "50" },
          });
          const products: any[] = ((await prodRes.json()) as any)?.data ?? [];
          const sellable = products.filter(
            (p) => p?.isActive !== false && /^[0-9A-Za-z-]{4,}$/.test(String(p?.sku ?? "")),
          );
          expect(
            sellable.length,
            "the tenant needs 2 active products with a SKU",
          ).toBeGreaterThanOrEqual(2);
          const [first, second] = sellable;

          const custRes = await page.request.get(`${api}/customers`, {
            headers,
            params: { limit: "5" },
          });
          const customer: any = (((await custRes.json()) as any)?.data ?? [])[0];
          expect(customer, "the tenant needs at least one customer").toBeTruthy();

          let draftId: string | null = null;
          try {
            if (profile.key === "pickup_ship") {
              await page.goto("/orders/counter-sale");
              const scanField = page.getByLabel("Scan or search items");
              await expect(scanField).toBeVisible({ timeout: 15_000 });
              const ship = page.getByRole("button", { name: "Ship this order instead" });
              await expect(ship, "the counter capability must offer SHIP").toBeVisible();

              const items = page.getByRole("list", { name: "Items" });
              for (const p of [first, second]) {
                await scanField.fill(String(p.sku));
                await scanField.press("Enter");
              }
              await expect(items.getByRole("listitem")).toHaveCount(2, { timeout: 15_000 });

              await page
                .getByLabel("Find a customer")
                .fill(String(customer.businessName).slice(0, 6));
              await page
                .getByRole("button", { name: String(customer.businessName) })
                .first()
                .click();

              await ship.click();
              await page.waitForURL(/\/orders(\?|$)/, { timeout: 20_000 });
            } else {
              // Delivery + ship: the counter is "optional" there, so it offers no "Ship this order instead" (that button is for
              // the in-store profiles). The picker case is the same parked SHIP draft the hand-off writes, resumed in the builder.
              await page.goto("/orders/counter-sale");
              await expect(page.getByLabel("Scan or search items")).toBeVisible({
                timeout: 15_000,
              });
              await expect(
                page.getByRole("button", { name: "Ship this order instead" }),
              ).toHaveCount(0);
              const line = (p: any, n: number) => ({
                tempId: `${p.id}-e2e71-${n}`,
                productId: p.id,
                productName: String(p.name),
                unit: "each",
                listPrice: Number(p.price ?? 1),
                unitPrice: Number(p.price ?? 1),
                priceType: "STANDARD",
                qty: 1,
              });
              const saved = await page.request.post(`${api}/drafts`, {
                headers,
                data: {
                  kind: "ORDER",
                  customerId: customer.id,
                  customerName: customer.businessName,
                  title: `Order, ${customer.businessName}`,
                  payload: {
                    customer: { id: customer.id, businessName: customer.businessName },
                    lineItems: [line(first, 1), line(second, 2)],
                    orderDiscount: "",
                    shippingFee: "",
                    requestedDeliveryDate: "",
                    orderDate: "",
                    notes: "",
                    urgent: false,
                    floorAcked: [],
                    fulfillPath: "SHIP",
                  },
                  device: "e2e",
                },
              });
              expect(saved.ok(), "POST /drafts").toBe(true);
              draftId = ((await saved.json()) as any)?.id ?? null;
              await page.goto(`/orders?resumeDraft=${encodeURIComponent(String(draftId))}`);
            }

            // The builder resumes the parked draft.
            await expect(
              page.getByRole("heading", { name: /resume draft|create order/i }),
            ).toBeVisible({ timeout: 15_000 });
            await expect(page.getByTitle("Remove")).toHaveCount(2);
            await expect(page.getByText(String(customer.businessName)).first()).toBeVisible();

            const picker = page.getByRole("button", { name: "Ship via carrier" });
            const routeOption = page.getByRole("button", { name: "Delivery route" });
            if (profile.key === "pickup_ship") {
              // One form method (SHIP): no choice to make, so no picker and no note.
              await expect(page.getByText("Fulfillment", { exact: true })).toHaveCount(0);
              await expect(picker).toHaveCount(0);
              await expect(routeOption).toHaveCount(0);
            } else {
              // Two methods: the picker is shown with SHIP selected, and the note.
              await expect(page.getByText("Fulfillment", { exact: true })).toBeVisible();
              await expect(routeOption).toBeVisible();
              await expect(picker).toBeVisible();
              await expect(picker).toHaveClass(/bg-navy/); // the selected option
              await expect(routeOption).not.toHaveClass(/bg-navy/);
              await expect(page.getByText(/Ships via carrier/)).toBeVisible();
            }

            // The parked draft itself carries fulfillPath SHIP (both profiles).
            const drafts = await page.request.get(`${api}/drafts`, { headers });
            const mine = (((await drafts.json()) as any[]) ?? []).find((d) =>
              draftId ? d?.id === draftId : d?.customerId === customer.id && d?.kind === "ORDER",
            );
            draftId = mine?.id ?? draftId;
            expect(draftId, "an ORDER draft is parked").toBeTruthy();
            expect(mine?.payload?.fulfillPath).toBe("SHIP");
          } finally {
            if (draftId) await page.request.delete(`${api}/drafts/${draftId}`, { headers });
          }
        });
      });
    }
  });
}
