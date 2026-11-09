/**
 * SA-963 A-1 (F13), the REAL API: the Feature Console's source chip and Details panel read the override's kind, reason and end date
 * off the live resolver. 49-feature-console.spec.ts and bo-web-console.spec.ts mock every endpoint, so they could not see that the
 * real `/features/effective` answer carried none of it (the chips "Free until <date>" and "On, kept from an earlier plan" never
 * rendered). This spec writes three real overrides on the approved `test` tenant through the platform-admin API, opens the Features tab
 * and reads the chips and the panel words; it revokes its rows afterwards. Nothing is mocked.
 *
 * Needs a super admin (PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD, `npm run local:sa`) and the `test` tenant (`npm run local:seed`).
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { HAS_SUPER_ADMIN_CREDS } from "./helpers/constants";
import { freshSuperAdminSession } from "./helpers/auth";
import { apiBase } from "./helpers/api";
import { testTenantId } from "./helpers/tenants";

test.skip(!HAS_SUPER_ADMIN_CREDS, "PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD not set");

const PROOF_DIR = path.join(__dirname, "../../../local-assets/proofs/2026-11-02/f13-source-chips");
fs.mkdirSync(PROOF_DIR, { recursive: true });

const DAY = 24 * 3600 * 1000;
// Enforced-gate keys, so a chip is never replaced by "On, not enforced yet".
const DATED_GRANT = "flag.msrp";
const KEPT_GRANT = "flag.sales_agents";
const DATED_DENY = "tobacco_dealer";

/** "Nov 30, 2026" in UTC: the same text the console's own helper prints. */
function utcDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

async function adminToken(page: Page): Promise<string> {
  return page.evaluate(() => window.localStorage.getItem("superAdminToken") ?? "");
}

test.describe("Feature Console source chips on the real API (SA-963 A-1)", () => {
  const created: string[] = [];
  let tenantId = "";

  test.afterEach(async ({ page }) => {
    const token = await adminToken(page).catch(() => "");
    for (const id of created.splice(0)) {
      await page.request.post(
        `${apiBase(page.url())}/api/v1/platform-admin/tenants/${tenantId}/feature-overrides/${id}/revoke`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
    }
  });

  for (const vp of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`the chips and the panel words render from the live resolver at ${vp.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(vp);
      await freshSuperAdminSession(page);
      tenantId = await testTenantId(page);
      const token = await adminToken(page);
      const api = `${apiBase(page.url())}/api/v1/platform-admin/tenants/${tenantId}`;
      const headers = { Authorization: `Bearer ${token}` };

      // Clear any leftover row of ours on these keys (a failed earlier run), so the create cannot 409.
      const existing = await page.request.get(`${api}/feature-overrides`, { headers });
      for (const row of (await existing.json()) as Array<{
        id: string;
        featureKey: string;
        revokedAt: string | null;
        reason: string;
      }>) {
        if (
          !row.revokedAt &&
          [DATED_GRANT, KEPT_GRANT, DATED_DENY].includes(row.featureKey) &&
          row.reason.startsWith("e2e sa963")
        ) {
          await page.request.post(`${api}/feature-overrides/${row.id}/revoke`, { headers });
        }
      }

      const grantEnds = new Date(Date.now() + 30 * DAY);
      const denyEnds = new Date(Date.now() + 14 * DAY);
      const make = async (body: Record<string, unknown>) => {
        const res = await page.request.post(`${api}/feature-overrides`, {
          headers,
          data: { acknowledgeUnmetRequires: true, ...body },
        });
        expect(res.status(), await res.text()).toBe(201);
        created.push(((await res.json()) as { id: string }).id);
      };
      await make({
        featureKey: DATED_GRANT,
        effect: "GRANT",
        kind: "COMP",
        reason: "e2e sa963 pilot month",
        expiresAt: grantEnds.toISOString(),
      });
      await make({
        featureKey: KEPT_GRANT,
        effect: "GRANT",
        kind: "GRANDFATHER",
        reason: "e2e sa963 kept",
      });
      await make({
        featureKey: DATED_DENY,
        effect: "DENY",
        kind: "SUPPORT",
        reason: "e2e sa963 abuse review",
        expiresAt: denyEnds.toISOString(),
      });

      await page.goto(`/admin/tenants/${tenantId}`);
      await page.getByRole("button", { name: "Features", exact: true }).click();
      const row = (key: string) => page.locator(`[data-feature-key="${key}"]`);
      const open = async (key: string) => {
        await row(key)
          .getByRole("button", { name: /^Details for / })
          .click();
        return page.locator(`[id="why-panel-${key}"]`);
      };

      // Chips (the live resolver's detail, not a mock).
      await expect(row(DATED_GRANT).getByTestId("readout")).toHaveText(
        `Free until ${utcDate(grantEnds)}`,
      );
      await expect(row(KEPT_GRANT).getByTestId("readout")).toHaveText(
        "On, kept from an earlier plan",
      );
      await expect(row(DATED_DENY).getByTestId("readout")).toHaveText("Off for this business");

      // Panel words: kind in words, the reason, the end date; never a raw enum.
      const grantPanel = await open(DATED_GRANT);
      await expect(grantPanel).toContainText(
        `added it (at no charge) — "e2e sa963 pilot month". Expires ${utcDate(grantEnds)}.`,
      );
      const keptPanel = await open(KEPT_GRANT);
      await expect(keptPanel).toContainText(
        'added it (kept from an earlier plan) — "e2e sa963 kept".',
      );
      const denyPanel = await open(DATED_DENY);
      await expect(denyPanel).toContainText(
        `removed it — "e2e sa963 abuse review". Expires ${utcDate(denyEnds)}.`,
      );
      for (const panel of [grantPanel, keptPanel, denyPanel]) {
        await expect(panel).not.toContainText(/\b(COMP|GRANDFATHER|SUPPORT|PILOT|TRIAL)\b/);
      }
      // Proof shot in the gitignored machine-local home (Heavy files policy), never in the repo.
      await page.screenshot({
        path: path.join(PROOF_DIR, `source-chips-${vp.width}.png`),
        fullPage: false,
      });
    });
  }
});
