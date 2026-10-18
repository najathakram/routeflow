/**
 * Shared plumbing for the Units v2 e2e specs (project `units-v2`, LOCAL LANE ONLY).
 *  - VIEWPORTS: the three widths every spec runs at.
 *  - requireUnitsV2Flag: reads the flags the logged-in tenant is SERVED (GET /billing/subscription, the endpoint
 *    useSubscription calls) and FAILS loudly when `flag.units_prices_v2` is absent. Never a skip: a skipped run proves nothing.
 *  - shot: screenshots go under local-assets/proofs/units-v2 (gitignored), never into the repo tree.
 */
import path from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { TENANT_SLUG } from "./constants";
import { apiBase, operatorAccessToken } from "./api";

export const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900, cards: false },
  { name: "768", width: 768, height: 1024, cards: false },
  { name: "390", width: 390, height: 844, cards: true },
] as const;

export const FLAG = "flag.units_prices_v2";

const SHOTS = path.join(__dirname, "..", "..", "..", "..", "local-assets", "proofs", "units-v2");

export async function apiContext(page: Page) {
  await page.goto("/orders");
  const token = await operatorAccessToken(page);
  expect(
    token,
    "no operator access token - operator storageState is stale or setup did not run",
  ).toBeTruthy();
  const api = `${apiBase(page.url())}/api/v1`;
  const headers = { authorization: `Bearer ${token}`, "x-tenant-slug": TENANT_SLUG };
  return { api, headers };
}

export async function requireUnitsV2Flag(
  page: Page,
): Promise<{ api: string; headers: Record<string, string> }> {
  const ctx = await apiContext(page);
  const res = await page.request.get(`${ctx.api}/billing/subscription`, { headers: ctx.headers });
  expect(res.ok(), `GET /billing/subscription returned ${res.status()}`).toBe(true);
  const body: any = await res.json();
  const flags: unknown = body?.flags;
  expect(
    Array.isArray(flags) && (flags as string[]).includes(FLAG),
    `Tenant "${TENANT_SLUG}" is not served ${FLAG} (served: ${JSON.stringify(flags)}). ` +
      "Run this lane against a stack built WITH the Units v2 feature and grant the flag to the test tenant, then re-run. " +
      "This spec never skips: a skip would report green having proven nothing about Units v2.",
  ).toBe(true);
  return ctx;
}

export async function shot(page: Page, info: TestInfo, name: string) {
  const vp = page.viewportSize()?.width ?? "x";
  await page.screenshot({ path: path.join(SHOTS, `${name}-${vp}.png`), fullPage: false });
  void info;
}

/** The first active, non-family product with the given SKU, or a hard failure naming the seed script. */
export async function productBySku(
  page: Page,
  ctx: { api: string; headers: Record<string, string> },
  sku: string,
) {
  const res = await page.request.get(`${ctx.api}/products`, {
    headers: ctx.headers,
    params: { search: sku, limit: "50" },
  });
  expect(res.ok(), `GET /products?search returned ${res.status()}`).toBe(true);
  const rows: any[] = ((await res.json()) as any)?.data ?? [];
  const p = rows.find((r) => r.sku === sku);
  expect(
    p,
    `Fixture product SKU "${sku}" not found - run \`node apps/api/scripts/e2e-seed.js\` and re-run.`,
  ).toBeTruthy();
  return p as { id: string; name: string; sku: string };
}
