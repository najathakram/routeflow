/**
 * Feature grants v2 brief C (PR-4/PR-5) — oracle 7. Exercises the real platform-admin
 * feature-config endpoint end to end (PUT sets a mode, requiring the tenant hold the mode's
 * `requires.allOf` addon first; GET reflects it; DELETE reverts to the registry default) against
 * the `e2e-routeflow` approved test tenant (CLAUDE.md test-tenant policy) — same
 * self-skip-without-SA-creds shape as 47-house-tenant-mrr-verify.spec.ts /
 * 01-super-admin.spec.ts, since a real SUPER_ADMIN login is required and no SA creds are seeded
 * locally (not in LOCAL-LANE.md's allow-list; a post-deploy-only spec).
 *
 * "the route page shows the allowed entry points on next load" (the brief's oracle 7 wording)
 * is INTENTIONALLY NOT asserted here and is self-skipped below with a named reason: brief A's
 * `/tenants/me/features` hook and authority/resolver are not on this base yet (only its schema +
 * shared contract landed, commit f6985746), so `apps/web/lib/feature-modes.ts`'s pure selector
 * (feature-modes.test.ts) is not wired into any page — see that file's header. The HARD
 * INVARIANT ("unset" before == after) holds by construction because the routes pages this brief
 * owns are untouched, not because this test proves it live. Wiring + this half of the oracle is
 * a follow-up once A's hook exists.
 */
import { test, expect } from "@playwright/test";
import { apiBase } from "./helpers/api";
import { HAS_SUPER_ADMIN_CREDS, TENANT_SLUG } from "./helpers/constants";

test.skip(!HAS_SUPER_ADMIN_CREDS, "PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD not set");

const FEATURE_KEY = "routes_dispatch";

test.describe("routes_dispatch config mode — platform-admin endpoint round trip", () => {
  test("PUT scheduled without recurring_routes -> 409; grant it -> 200; DELETE reverts to unset", async ({
    page,
  }) => {
    const base = `${apiBase(page.url())}/api/v1`;

    const tenantsRes = await page.request.get(
      `${base}/platform-admin/tenants?search=${TENANT_SLUG}&limit=1`,
    );
    expect(tenantsRes.ok()).toBeTruthy();
    const tenantsBody = await tenantsRes.json();
    const tenantId: string | undefined = tenantsBody?.data?.[0]?.id;
    test.skip(!tenantId, `tenant "${TENANT_SLUG}" not found — seed it first (npm run local:seed)`);
    if (!tenantId) return;

    const configUrl = `${base}/platform-admin/tenants/${tenantId}/feature-config/${FEATURE_KEY}`;

    // Baseline: no row yet -> unset / REGISTRY_DEFAULT (or whatever a prior run of this same
    // spec left it as — clean up defensively before asserting anything).
    await page.request.delete(configUrl);
    const baseline = await (await page.request.get(configUrl)).json();
    expect(baseline).toMatchObject({ value: "unset", source: "REGISTRY_DEFAULT" });

    // 409 before the tenant holds recurring_routes.
    const deniedRes = await page.request.put(configUrl, {
      data: { mode: "scheduled", reason: "e2e 50-routes-dispatch-mode" },
    });
    expect(deniedRes.status()).toBe(409);
    const deniedBody = await deniedRes.json();
    expect(deniedBody.message).toMatchObject({
      key: FEATURE_KEY,
      mode: "scheduled",
      missing: "recurring_routes",
    });

    // Grant recurring_routes, then the PUT succeeds and GET reflects it.
    const grantRes = await page.request.post(`${base}/platform-admin/tenants/${tenantId}/addons`, {
      data: { addonKey: "recurring_routes" },
    });
    expect(grantRes.ok()).toBeTruthy();

    const setRes = await page.request.put(configUrl, {
      data: { mode: "scheduled", reason: "e2e 50-routes-dispatch-mode" },
    });
    expect(setRes.ok()).toBeTruthy();
    const setBody = await setRes.json();
    expect(setBody).toMatchObject({ value: "scheduled", effective: "scheduled", source: "TENANT" });

    // DELETE reverts to the registry default, never leaving this test tenant configured.
    const clearRes = await page.request.delete(configUrl);
    expect(clearRes.ok()).toBeTruthy();
    const clearBody = await clearRes.json();
    expect(clearBody).toMatchObject({ value: "unset", source: "REGISTRY_DEFAULT" });
  });
});

test.describe("routes_dispatch config mode — route page reflects the effective mode (follow-up)", () => {
  test.skip(
    true,
    "apps/web/lib/feature-modes.ts is not wired into any page yet — blocked on brief A's " +
      "/tenants/me/features hook (not on this base as of commit f6985746). See this file's " +
      "header and feature-modes.test.ts for the selector-level proof that IS provable today.",
  );

  test("set mode via the admin endpoint -> the route page shows the allowed entry points on next load; clear -> today's UI", async () => {
    // Intentionally empty — see the test.skip reason above.
  });
});
