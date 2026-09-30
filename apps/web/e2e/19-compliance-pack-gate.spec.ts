/**
 * Tobacco→Regulated consolidation gate. READ-ONLY: GETs and renders only.
 * Branches on the tenant's live addon state via GET /tenants/me/addons so it
 * is green both before and after tobacco_dealer is enabled on the e2e tenant.
 */
import { test, expect } from "@playwright/test";
import { apiBase, operatorAccessToken } from "./helpers/api";

test("compliance pack follows the tobacco_dealer addon; /tobacco redirects", async ({ page }) => {
  await page.goto("/dashboard");
  const token = await operatorAccessToken(page);
  test.skip(!token, "no operator token — auth setup did not run");
  const res = await page.request.get(`${apiBase(page.url())}/api/v1/tenants/me/addons`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { addons = [] } = await res.json();
  const enabled = addons.includes("tobacco_dealer");

  // The standalone /tobacco leaf is gone for everyone (a section NAMED
  // "Tobacco" may legitimately appear in the Regulated Items group, so
  // assert on the href, not the label).
  await expect(page.getByRole("navigation").locator('a[href="/tobacco"]')).toHaveCount(0);

  // Deep links in the wild must not 404 — /tobacco redirects into the hub.
  await page.goto("/tobacco");
  await page.waitForURL(/\/compliance(\/|$)?/, { timeout: 15_000 });

  await page.goto("/compliance");
  // Scope to <main>: the dashboard shell's top bar renders the page title as an
  // <h1> too, so an unscoped heading locator matches twice (strict-mode violation).
  await expect(
    page.getByRole("main").getByRole("heading", { name: "Regulated Items" }),
  ).toBeVisible();
  if (enabled) {
    await expect(page.getByText(/isn't enabled for this workspace/i)).toHaveCount(0);
  } else {
    await expect(page.getByText(/isn't enabled for this workspace/i)).toBeVisible();
  }
});
