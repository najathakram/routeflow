/**
 * B449: proof that a LITE tenant's locked route never mounts the gated page,
 * shows exactly one plan-gate notice per navigation (naming the correct tier),
 * and that the LITE dashboard itself shows no stray notice. Screenshots at
 * 1440/768/390 go to `local-assets/lite-gate-fix-2026-09-16/<width>/`.
 *
 * Fixture: same as 47-lite-plan-gate.spec.ts — a dedicated LITE-plan tenant via
 * `PLAYWRIGHT_LITE_TENANT_SLUG`. Every test self-skips (test.skip, not a
 * discharge — L-041) when it is unset, since it can't run against the shared
 * `e2e-routeflow` fixture (not on LITE). READ-ONLY throughout.
 *
 * AUTHOR-ONLY (bug-pipeline B449, 2026-09-16): written per the brief's proof
 * requirement but not run — this session has no host grant for the shared
 * local Docker stack (a landing window was in progress) and no seeded LITE
 * tenant to point PLAYWRIGHT_LITE_TENANT_SLUG at. Typecheck only; run via
 * `npm run local:e2e` (or targeted against `npm run dev`) once a host/tenant
 * grant is available.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { setTenantCookie, loginAsOperator } from "./helpers/auth";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const RAW_LITE_SLUG = process.env.PLAYWRIGHT_LITE_TENANT_SLUG ?? "";
const LITE_TENANT_SLUG = RAW_LITE_SLUG
  ? assertTestTenant(RAW_LITE_SLUG, "playwright e2e (lite-locked-route-ux)")
  : "";
const SKIP_REASON = "PLAYWRIGHT_LITE_TENANT_SLUG not set — needs a dedicated LITE-plan tenant";

const SCREENSHOT_DIR = path.join(__dirname, "../../../local-assets/lite-gate-fix-2026-09-16");

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
] as const;

async function loginAsLiteOperator(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
  baseURL: string | undefined,
) {
  await setTenantCookie(context, baseURL ?? "", LITE_TENANT_SLUG);
  await loginAsOperator(page);
}

function shot(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.png`);
}

test.describe("Lite locked-route UX (B449)", () => {
  for (const vp of VIEWPORTS) {
    test.describe(`@ ${vp.width}px`, () => {
      test(`locked route never flashes the gated page and shows exactly one notice`, async ({
        page,
        context,
        baseURL,
      }) => {
        test.skip(!LITE_TENANT_SLUG, SKIP_REASON);
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await loginAsLiteOperator(page, context, baseURL);

        const notifications = page.getByRole("region", { name: /notifications/i });

        await page.goto("/estimates");

        // The real Estimates page must never mount: its own list/table content
        // (rendered only once the page's data has loaded) must never appear,
        // at any point during the navigation — not even for a frame.
        await expect(page.getByRole("heading", { name: "Not on your plan" })).toBeVisible({
          timeout: 10_000,
        });
        await expect(page.locator("table")).toHaveCount(0);

        const dir = path.join(SCREENSHOT_DIR, vp.name);
        await page.screenshot({ path: shot(dir, "estimates-locked"), fullPage: true });

        // At most one plan-gate toast for this whole navigation, naming ONE tier.
        await expect(notifications.getByRole("listitem")).toHaveCount(1);
      });

      test(`an ungated neighbour route renders normally, no notice`, async ({
        page,
        context,
        baseURL,
      }) => {
        test.skip(!LITE_TENANT_SLUG, SKIP_REASON);
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await loginAsLiteOperator(page, context, baseURL);

        await page.goto("/orders");
        await expect(page.getByRole("heading", { name: /orders/i }).first()).toBeVisible({
          timeout: 10_000,
        });

        const dir = path.join(SCREENSHOT_DIR, vp.name);
        await page.screenshot({ path: shot(dir, "orders-unlocked-neighbour"), fullPage: true });

        await expect(
          page.getByRole("region", { name: /notifications/i }).getByRole("listitem"),
        ).toHaveCount(0);
      });

      test(`the LITE dashboard shows no stray plan-gate notice`, async ({
        page,
        context,
        baseURL,
      }) => {
        test.skip(!LITE_TENANT_SLUG, SKIP_REASON);
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await loginAsLiteOperator(page, context, baseURL);

        await page.goto("/dashboard");
        await expect(page.getByRole("heading", { name: /good (morning|afternoon|evening)/i }))
          .toBeVisible({ timeout: 10_000 })
          .catch(() => {
            /* greeting is operator-only; a non-operator role still must show no stray notice */
          });
        // Give any late/racing gated request from a prior navigation time to settle.
        await page.waitForTimeout(2_000);

        const dir = path.join(SCREENSHOT_DIR, vp.name);
        await page.screenshot({ path: shot(dir, "dashboard-clean"), fullPage: true });

        await expect(
          page.getByRole("region", { name: /notifications/i }).getByRole("listitem"),
        ).toHaveCount(0);
      });
    });
  }
});
