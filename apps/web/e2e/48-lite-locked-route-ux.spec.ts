/**
 * B449: proof that a LITE tenant's locked route never mounts the gated page,
 * shows exactly one plan-gate notice per navigation naming this tenant's own
 * plan (never a stray/contradictory tier from another widget), and that the
 * LITE dashboard itself shows no stray notice. Screenshots at 1440/768/390 go
 * to `local-assets/lite-gate-fix-2026-09-16/<width>/`.
 *
 * Fixture: `qa-lite` (LITE_TENANT_SLUG, `helpers/constants.ts`) — a standing,
 * always-seeded LITE-plan tenant (apps/api/scripts/e2e-seed.js's
 * `seedQaLiteTenant`, run by every `global.setup.ts` pass). Unlike
 * 47-lite-plan-gate.spec.ts (which needs a hand-provisioned tenant via
 * PLAYWRIGHT_LITE_TENANT_SLUG and self-skips without one), this fixture is now
 * standing infrastructure — these tests do NOT self-skip LOCALLY; a
 * missing/misseeded fixture there is a real, loud failure, same as any other
 * allow-listed local spec. Allow-listed for `npm run local:e2e` (see
 * LOCAL-LANE.md). READ-ONLY throughout.
 *
 * Fix-round finding 3: `global.setup.ts` skips seeding entirely when CI=true
 * and no DB URL is configured (the deploy-triggered post-deploy job — this
 * repo's e2e specs never run under any OTHER CI trigger, so `CI === "true"`
 * unambiguously means that job here) — `qa-lite` is not provisioned there.
 * Self-skip ONLY in that environment, with a visible annotation naming why;
 * `local:e2e` always sets `CI` unset (see local-env.mjs), so the local gate is
 * never affected.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { setTenantCookie, loginAsOperator } from "./helpers/auth";
import { LITE_TENANT_SLUG } from "./helpers/constants";

const SCREENSHOT_DIR = path.join(__dirname, "../../../local-assets/lite-gate-fix-2026-09-16");

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
] as const;

/** This tenant's own gate message (PlanGateBoundary.tsx) — deterministic per plan, never
 *  per-flag, so asserting it proves the notice is THIS route's own gate, not a stray 403
 *  from an unrelated widget naming a different tier. */
const LITE_GATE_MESSAGE = "This feature isn't included in the Lite plan.";

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

/** Fix-round finding 3: the deploy-triggered post-deploy job runs with CI=true and
 *  no DB URL configured, so global.setup.ts skips seeding qa-lite entirely there —
 *  this repo's e2e specs never run under any OTHER CI trigger, so CI=true
 *  unambiguously means that job. An explicit PLAYWRIGHT_LITE_TENANT_SLUG override
 *  (a fixture deliberately provisioned there) still runs normally. */
const SKIP_IN_UNPROVISIONED_CI =
  process.env.CI === "true" && !process.env.PLAYWRIGHT_LITE_TENANT_SLUG;
const CI_SKIP_REASON =
  "qa-lite fixture not provisioned in this environment (CI with no seed DB URL) — B449 proof is the local lane (npm run local:e2e)";

test.describe("Lite locked-route UX (B449)", () => {
  test.beforeEach(() => {
    test.skip(SKIP_IN_UNPROVISIONED_CI, CI_SKIP_REASON);
  });

  for (const vp of VIEWPORTS) {
    test.describe(`@ ${vp.width}px`, () => {
      test(`locked route never flashes the gated page and shows exactly one notice naming this plan`, async ({
        page,
        context,
        baseURL,
      }) => {
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

        // At most one plan-gate toast for this whole navigation, and its text is
        // THIS tenant's own gate message — never a different, contradictory tier
        // from a stray gated fetch elsewhere on the page.
        const items = notifications.getByRole("listitem");
        await expect(items).toHaveCount(1);
        await expect(items).toContainText(LITE_GATE_MESSAGE);
      });

      test(`an ungated neighbour route renders normally, no notice`, async ({
        page,
        context,
        baseURL,
      }) => {
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
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await loginAsLiteOperator(page, context, baseURL);

        await page.goto("/dashboard");
        await expect(page.getByText(/good (morning|afternoon|evening)/i)).toBeVisible({
          timeout: 10_000,
        });
        // Give any late/racing gated request from a prior navigation time to settle
        // (B449 fix-round finding 2: the header bell's pending-portal-approvals fetch
        // must never fire for a LITE tenant at all — this is the regression guard).
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
