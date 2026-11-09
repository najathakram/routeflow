/**
 * WP10 proof captures: the five tabs of one business's admin page at 1440 / 768 / 390, on an approved test
 * tenant of the LOCAL stack. Screenshots land in <repo>/local-assets/wp10-captures (gitignored, never in docs/).
 * Also proves, in a real browser, that an old ?tab= link opens the new tab, and that no tab scrolls sideways.
 *
 *   node scripts/local-env.mjs --proof-stack --e2e -- "npm --prefix apps/web run test:e2e -- --project=bo-web wp10-captures --workers=1"
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { HAS_SUPER_ADMIN_CREDS } from "./helpers/constants";
import { freshSuperAdminSession } from "./helpers/auth";
import { gotoTestTenant } from "./helpers/tenants";

test.skip(!HAS_SUPER_ADMIN_CREDS, "PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD not set");

const OUT = path.resolve(__dirname, "../../../local-assets/wp10-captures");
const SLUG = process.env.BO_TENANT_SLUG ?? "e2e-routeflow";
const WIDTHS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
] as const;
const TABS = [
  ["overview", "Overview"],
  ["features", "Features"],
  ["billing", "Plan & billing"],
  ["details", "Business details"],
  ["history", "History"],
] as const;

test.beforeEach(async ({ page }) => {
  await freshSuperAdminSession(page);
});

for (const vp of WIDTHS) {
  test(`WP10 five tabs at ${vp.name}`, async ({ page, browserName }, info) => {
    fs.mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await gotoTestTenant(page, "overview", SLUG);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
    const ua = await page.evaluate(() => navigator.userAgent);
    fs.writeFileSync(
      path.join(OUT, "environment.txt"),
      `OS: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()})\nBrowser: ${browserName} ${info.project.name}\nUser agent: ${ua}\n`,
    );
    for (const [key, label] of TABS) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`tab=${key}`));
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(800);
      const main = page.locator("main").first();
      const dims = await main.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
      const wide = await main.evaluate((el) => {
        const lim = el.clientWidth;
        return Array.from(el.querySelectorAll("*"))
          .filter(
            (n) =>
              n.getBoundingClientRect().right > el.getBoundingClientRect().left + lim &&
              !n.closest(".overflow-x-auto,.overflow-hidden"),
          )
          .slice(0, 4)
          .map((n) => `${n.tagName}.${String(n.className).slice(0, 60)}`);
      });
      expect(
        dims.sw,
        `${key} at ${vp.name} scrolls sideways: ${wide.join(" | ")}`,
      ).toBeLessThanOrEqual(dims.cw);
      await page.screenshot({
        path: path.join(OUT, `${vp.name}-${key}.png`),
        fullPage: true,
      });
    }
  });
}

test("WP10 old tab links open the new tab and the URL is rewritten", async ({ page }) => {
  await gotoTestTenant(page, "overview", SLUG);
  const base = page.url().split("?")[0];
  for (const [old, next] of [
    ["setup", "features"],
    ["config", "details"],
    ["snapshots", "history"],
    ["audit", "history"],
  ]) {
    await page.goto(`${base}?tab=${old}`);
    await expect(page).toHaveURL(new RegExp(`tab=${next}`), { timeout: 15_000 });
  }
});
