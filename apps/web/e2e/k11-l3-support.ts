/**
 * Shared plumbing for the K11 L3 e2e specs (`k11-l3-*.spec.ts`, LOCAL LANE ONLY).
 * Same rules as the units-v2 lane: approved test tenant only, `flag.units_prices_v2` served (a tenant
 * without it FAILS the spec, never skips), screenshots under local-assets/proofs/units-v2 (gitignored).
 */
import { expect, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

export { VIEWPORTS, shot };

export const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
/** Case x12 fixture with a typed Retail price (apps/api/scripts/e2e-seed.js). */
export const UNITS_SKU = "E2E-FIX-UNITS";

export type Ctx = { api: string; headers: Record<string, string> };

/** Logs in as the operator, checks the flag, and opens the fixture product's page. */
export async function openFixtureProduct(
  page: Page,
  context: Parameters<typeof setTenantCookie>[0],
  sku: string = UNITS_SKU,
) {
  await setTenantCookie(context, BASE);
  const ctx = await requireUnitsV2Flag(page);
  const product = await productBySku(page, ctx, sku);
  await page.goto(`/products/${product.id}`);
  await expect(page.locator("h1#h-product")).toBeVisible({ timeout: 20_000 });
  return { ...ctx, productId: product.id };
}

/** An active FAMILY product, self-provisioned on the approved test tenant when the seed has none. */
export async function ensureFamily(page: Page, ctx: Ctx) {
  const list = async () => {
    const res = await page.request.get(`${ctx.api}/products`, {
      headers: ctx.headers,
      params: { limit: "200" },
    });
    expect(res.ok(), `GET /products returned ${res.status()}`).toBe(true);
    const rows: any[] = ((await res.json()) as any)?.data ?? [];
    return rows.find((p) => p?.isActive !== false && p.kind === "FAMILY");
  };
  let family = await list();
  if (!family) {
    const made = await page.request.post(`${ctx.api}/products/families`, {
      headers: ctx.headers,
      data: {
        family: { name: "E2E Fixture Family", pricePerUnit: "5.00" },
        variants: [
          { name: "E2E Variant A", sku: "E2E-FIX-FAM-A", pricePerUnit: "5.00" },
          { name: "E2E Variant B", sku: "E2E-FIX-FAM-B", pricePerUnit: "5.50" },
        ],
      },
    });
    expect(made.ok(), `POST /products/families returned ${made.status()}`).toBe(true);
    family = await list();
  }
  expect(family, "no active family product after self-provisioning").toBeTruthy();
  return family as { id: string; name: string };
}

/** The viewport-bottom edge the "first screen" claims are measured against. */
export function viewportHeight(page: Page): number {
  return page.viewportSize()!.height;
}
