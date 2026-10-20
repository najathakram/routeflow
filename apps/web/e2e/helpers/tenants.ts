import { expect, type Page } from "@playwright/test";
import { apiBase } from "./api";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

/**
 * The id of an approved test tenant (default slug `test`), found BY SLUG through the platform-admin
 * API. Never read it off page 1 of the tenants list: a compose DB with many qa-* / e2e-* tenants
 * pushes `test` onto a later page (client-data policy: also never `limit=1`).
 * Call after a Super Admin session exists (`freshSuperAdminSession`).
 */
export async function testTenantId(page: Page, slug: string = "test"): Promise<string> {
  assertTestTenant(slug, "playwright e2e (back-office)");
  const token = await page.evaluate(() => window.localStorage.getItem("superAdminToken") ?? "");
  const res = await page.request.get(
    `${apiBase(page.url())}/api/v1/platform-admin/tenants?search=${encodeURIComponent(slug)}&limit=50`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  expect(res.ok(), `platform-admin tenant search for "${slug}" returned ${res.status()}`).toBe(
    true,
  );
  const body = (await res.json()) as { data?: { id: string; slug: string }[] };
  const matches = (body.data ?? []).filter((t) => t.slug === slug);
  expect(matches, `exactly one tenant with slug "${slug}"`).toHaveLength(1);
  return matches[0]!.id;
}

/** Opens `/admin/tenants/<id>` (optionally on a tab) for an approved test tenant; returns the id. */
export async function gotoTestTenant(
  page: Page,
  tab?: string,
  slug: string = "test",
): Promise<string> {
  const id = await testTenantId(page, slug);
  await page.goto(`/admin/tenants/${id}${tab ? `?tab=${tab}` : ""}`);
  return id;
}
