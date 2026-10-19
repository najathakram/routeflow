/**
 * BO-08: the Backoffice tenant Overview and Billing tabs fit a 390px screen.
 *
 * STATUS: written but NOT RUN (no browser in the build session). Red on master: Overview
 * `main.scrollWidth` is 559 at 390 because the grid's implicit column grows to the audit table's
 * min-content. Jest pins the structure (page.test.tsx, "BO-08"); this spec proves the layout.
 *
 * Needs: PLAYWRIGHT_BASE_URL (required, no default) and super admin credentials via the
 * "super-admin" project's storage state. Approved test tenants only: slug `test` or `qa-*`
 * (override with BO_TENANT_SLUG).
 */

import { test, expect, type Page } from "@playwright/test";
import { HAS_SUPER_ADMIN_CREDS } from "./helpers/constants";
import { freshSuperAdminSession } from "./helpers/auth";

test.skip(!HAS_SUPER_ADMIN_CREDS, "PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD not set");

test.beforeEach(async ({ page }) => {
  if (HAS_SUPER_ADMIN_CREDS) await freshSuperAdminSession(page);
});

/** The base URL comes from the environment only. Throws when unset: there is no default URL. */
function requireBaseUrl(): string {
  const url = process.env.PLAYWRIGHT_BASE_URL;
  if (!url) {
    throw new Error("PLAYWRIGHT_BASE_URL is not set. Point it at the local stack under test.");
  }
  return url.replace(/\/$/, "");
}

/** Only approved test tenants (CLAUDE.md "Test tenants"): `test` or a throwaway `qa-*` slug. */
function approvedTenantSlug(): string {
  const slug = process.env.BO_TENANT_SLUG ?? "test";
  if (slug !== "test" && !/^qa-[a-z0-9-]+$/.test(slug)) {
    throw new Error(`BO_TENANT_SLUG "${slug}" is not an approved test tenant (test or qa-*).`);
  }
  return slug;
}

async function openTenant(page: Page, tab: "overview" | "billing") {
  const base = requireBaseUrl();
  await page.goto(`${base}/admin/tenants`);
  await page.getByText(approvedTenantSlug(), { exact: true }).first().click();
  await page.waitForURL(/\/admin\/tenants\/[^/?]+/);
  const id = new URL(page.url()).pathname.split("/")[3];
  await page.goto(`${base}/admin/tenants/${id}?tab=${tab}`);
  await expect(page.locator("main h2").first()).toBeVisible({ timeout: 15_000 });
}

const WIDTHS = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
] as const;

for (const tab of ["overview", "billing"] as const) {
  for (const vp of WIDTHS) {
    test(`BO-08 ${tab} at ${vp.name}: no sideways scroll, cards inside the viewport`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openTenant(page, tab);

      const main = page.locator("main").first();
      const dims = await main.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth);

      const rights = await main.locator("h2").evaluateAll((hs, vw) => {
        return hs
          .map((h) => h.closest("div.rounded-xl") as HTMLElement | null)
          .filter((c): c is HTMLElement => c !== null)
          .map((c) => Math.round(c.getBoundingClientRect().right) - (vw as number));
      }, vp.width);
      for (const overshoot of rights) expect(overshoot).toBeLessThanOrEqual(0);
    });
  }

  test(`BO-08 ${tab} at 1440: two cards share a row`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTenant(page, tab);
    const tops = await page
      .locator("main div.rounded-xl")
      .evaluateAll((cards) => cards.map((c) => Math.round(c.getBoundingClientRect().top)));
    // At lg two half-width cards sit on the same row, so some top value repeats.
    expect(new Set(tops).size).toBeLessThan(tops.length);
  });
}
