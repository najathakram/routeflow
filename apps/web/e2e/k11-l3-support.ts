/**
 * Shared plumbing for the K11 L3 e2e specs (`k11-l3-*.spec.ts`, LOCAL LANE ONLY).
 * Same rules as the units-v2 lane: approved test tenant only, `flag.units_prices_v2` served (a tenant
 * without it FAILS the spec, never skips), screenshots under local-assets/proofs/units-v2 (gitignored).
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { setTenantCookie } from "./helpers/auth";
import { VIEWPORTS, productBySku, requireUnitsV2Flag, shot } from "./helpers/units-v2-support";

export { VIEWPORTS, shot };

export const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";
/** Case x12 fixture with a typed Retail price (apps/api/scripts/e2e-seed.js). */
export const UNITS_SKU = "E2E-FIX-UNITS";

export type Ctx = { api: string; headers: Record<string, string> };

/**
 * Logs in as the operator, checks the flag is served, and opens a product page. By default the fixture product; pass
 * `productId` for another one. `flagOff` opens the SAME tenant as if `flag.units_prices_v2` were not served, by
 * stripping it from the subscription answer the browser receives (the flag is read client-side), so a flag-OFF
 * pass needs no second tenant. API calls the spec makes itself (page.request) still see the real flags.
 */
export async function openFixtureProduct(
  page: Page,
  context: Parameters<typeof setTenantCookie>[0],
  sku: string = UNITS_SKU,
  opts: { productId?: string; flagOff?: boolean } = {},
) {
  await setTenantCookie(context, BASE);
  const ctx = await requireUnitsV2Flag(page);
  const productId = opts.productId ?? (await productBySku(page, ctx, sku)).id;
  if (opts.flagOff) {
    await page.route("**/billing/subscription*", async (route) => {
      const res = await route.fetch();
      const body: any = await res.json();
      body.flags = (body.flags ?? []).filter((f: string) => f !== "flag.units_prices_v2");
      await route.fulfill({ response: res, json: body });
    });
  }
  await page.goto(`/products/${productId}`);
  await expect(page.locator("h1#h-product")).toBeVisible({ timeout: 20_000 });
  return { ...ctx, productId };
}

/** A 1x1 PNG, the smallest image the upload endpoint accepts. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Uploads `n` one-pixel images to a product over the API (one request each: the field name repeats). */
export async function seedImages(page: Page, ctx: Ctx, productId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const res = await page.request.post(`${ctx.api}/products/${productId}/images`, {
      headers: ctx.headers,
      multipart: { files: { name: `k11-${i}.png`, mimeType: "image/png", buffer: PNG_1X1 } },
    });
    expect(res.ok(), `upload image ${i + 1}: ${res.status()}`).toBeTruthy();
  }
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

/*
 * Page coordinates. The dashboard scrolls inside #main-content, so window.scrollY is always 0 and
 * `rect.top + window.scrollY` DROPS as focus scrolls the page. These measure from the top of the scrolling content:
 * rect.top - main.rect.top + main.scrollTop. (The bodies are inlined: they run in the browser.)
 */

/** Page top of the focused element, or null when focus is outside #main-content (the app header band). */
export async function focusedPageTop(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const main = document.querySelector("#main-content");
    if (!el || !main || !main.contains(el)) return null;
    return el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
  });
}

/** Page top of a locator's element, from the top of the scrolling content. */
export async function pageTopOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const main = document.querySelector("#main-content");
    if (!main) return el.getBoundingClientRect().top + window.scrollY;
    return el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
  });
}
