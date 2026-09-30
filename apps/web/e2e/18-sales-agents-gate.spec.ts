/**
 * PR-D (18): Sales-agents UI entitlement gate. READ-ONLY: GETs and renders only —
 * no create/approve/payout is ever clicked. Branches on the tenant's live addon
 * state via GET /tenants/me/addons (helpers/api.ts pattern) so it is green both
 * before and after the sales_agents addon is enabled on the e2e tenant.
 */
import { test, expect } from "@playwright/test";
import { apiBase, operatorAccessToken } from "./helpers/api";

test("sales-agents surfaces follow the addon flag", async ({ page }) => {
  await page.goto("/dashboard");
  const token = await operatorAccessToken(page);
  test.skip(!token, "no operator token — auth setup did not run");
  const res = await page.request.get(`${apiBase(page.url())}/api/v1/tenants/me/addons`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { addons = [] } = await res.json();
  const enabled = addons.includes("sales_agents");

  const nav = page.getByRole("navigation");
  if (!enabled) {
    await expect(nav.getByText("Sales Agents")).toHaveCount(0);
    // Deep-link renders the locked card, not a crash or a toast storm.
    await page.goto("/sales-agents");
    await expect(page.getByText(/isn't enabled for this workspace/i)).toBeVisible();
  } else {
    await expect(nav.getByText("Sales Agents")).toBeVisible();
    await page.goto("/sales-agents");
    await expect(page.getByRole("button", { name: /add agent/i })).toBeVisible();
    await page.goto("/finance/commissions");
    await expect(page.getByRole("button", { name: /generate/i })).toBeVisible();
  }
});
