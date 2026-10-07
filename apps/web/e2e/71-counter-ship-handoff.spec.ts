/**
 * B1210 (71): the counter sale's "Ship this order instead" carries the cart over.
 *   scan 2 products -> pick a customer -> Ship this order instead
 *   -> the order builder opens on the parked draft: the same 2 lines, the customer, and "Ship via carrier" on.
 * At 1440 / 768 px.
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
] as const;

let before: FulfilmentSnapshot | null = null;
let capabilityBefore: unknown = null;
const target = () => localTarget(apiBase(BASE));

test.beforeAll(async () => {
  before = await snapshotFulfilmentConfig(target()); // read first: nothing is written until this succeeds
  capabilityBefore = await readApiCapability(target()); // what the API reports before the spec touches anything
  await applyBusinessProfile(target(), before, "in_store_shipping_retailer");
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
  test.describe(`B1210 counter -> ship hand-off @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("scan 2 -> Ship this order instead -> the builder shows 2 lines, the customer, Ship via carrier", async ({
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

        await page.getByLabel("Find a customer").fill(String(customer.businessName).slice(0, 6));
        await page
          .getByRole("button", { name: String(customer.businessName) })
          .first()
          .click();

        await ship.click();
        await page.waitForURL(/\/orders(\?|$)/, { timeout: 20_000 });

        // The builder resumes the parked draft.
        await expect(page.getByRole("heading", { name: /resume draft|create order/i })).toBeVisible(
          {
            timeout: 15_000,
          },
        );
        await expect(page.getByTitle("Remove")).toHaveCount(2);
        await expect(page.getByText(String(customer.businessName)).first()).toBeVisible();
        await expect(page.getByText(/Ships via carrier/)).toBeVisible();

        // Find the parked draft for cleanup.
        const drafts = await page.request.get(`${api}/drafts`, { headers });
        const mine = (((await drafts.json()) as any[]) ?? []).find(
          (d) => d?.customerId === customer.id && d?.kind === "ORDER",
        );
        draftId = mine?.id ?? null;
      } finally {
        if (draftId) await page.request.delete(`${api}/drafts/${draftId}`, { headers });
      }
    });
  });
}
