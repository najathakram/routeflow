#!/usr/bin/env node
/**
 * B450 — guarded, dry-run-by-default reset of a TEST tenant's plan, via the real
 * `PATCH /platform-admin/tenants/:id/plan` path (the same write a platform-admin UI
 * click makes — never raw SQL; see `lib/platform-admin-http.mjs`'s header).
 *
 * Written because `e2e-routeflow`'s post-deploy E2E has been red since #777:
 * `POST /recurring-invoices` 403s under `PlanFlagGuard`. `report-tenant-plan.mjs
 * e2e-routeflow` is the read-only first step — run it first to CONFIRM the tenant is
 * really pinned off its intended plan before writing anything.
 *
 * `assertTestTenant` is a HARD guard, checked before any network call: this script can
 * only ever target `e2e-routeflow`/`test`/`routeflow-demo`/`qa-*`/`e2e-*`/`ux-audit-*` —
 * never a live client tenant, no override.
 *
 * Usage (dry run — the default; prints the intended change, writes nothing):
 *   API_URL=https://routeflowapi-production-....up.railway.app/api/v1 \
 *   SUPER_ADMIN_USERNAME=... SUPER_ADMIN_PASSWORD=... \
 *   node apps/api/scripts/set-e2e-tenant-plan.mjs --slug e2e-routeflow --plan SCALE
 *
 * Usage (apply):
 *   ...same env... node apps/api/scripts/set-e2e-tenant-plan.mjs --slug e2e-routeflow --plan SCALE --apply
 *
 * API_URL defaults to http://localhost:3000/api/v1 (printed either way) — this hits a
 * RUNNING API process over HTTP; point API_URL at the deployed Railway URL to fix prod.
 */
import { createRequire } from "node:module";
import {
  resolveApiBase,
  loginAsSuperAdmin,
  findTenantBySlug,
  getTenantDetail,
  getResolvedSubscription,
  updateTenantPlan,
  LITE_L2_FLAGS,
} from "./lib/platform-admin-http.mjs";

const require = createRequire(import.meta.url);
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

function parseArgs(argv) {
  const args = { apply: argv.includes("--apply") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--slug") args.slug = argv[++i];
    if (argv[i] === "--plan") args.plan = argv[++i];
  }
  return args;
}

async function printResolved(base, adminToken, tenantId, label) {
  const resolved = await getResolvedSubscription(base, adminToken, tenantId);
  const flags = resolved.flags ?? [];
  console.log(`\n${label}: planKey=${resolved.planKey} planName="${resolved.planName}"`);
  for (const flag of LITE_L2_FLAGS) {
    console.log(`  ${flags.includes(flag) ? "✓ granted" : "✗ missing"}  ${flag}`);
  }
  return resolved;
}

async function main() {
  const { slug, plan, apply } = parseArgs(process.argv.slice(2));
  if (!slug || !plan) {
    console.error(
      "Usage: node apps/api/scripts/set-e2e-tenant-plan.mjs --slug <slug> --plan <PLAN> [--apply]",
    );
    process.exit(1);
  }

  // HARD guard — before any network call. No override, no exception.
  assertTestTenant(slug, "set-e2e-tenant-plan.mjs");

  const base = resolveApiBase();
  const adminToken = await loginAsSuperAdmin(base);

  const found = await findTenantBySlug(base, adminToken, slug);
  const detail = await getTenantDetail(base, adminToken, found.id);

  console.log(`\nTarget: ${slug} (${found.id})`);
  console.log(`Current Tenant.plan enum:      ${detail.plan}`);
  console.log(`Current TenantSubscription.planKey: ${detail.subscription?.planKey ?? "(none)"}`);
  await printResolved(base, adminToken, found.id, "Current resolved");

  if (!apply) {
    console.log(
      `\nDRY RUN — would PATCH /platform-admin/tenants/${found.id}/plan { plan: "${plan}" }.`,
    );
    console.log("Pass --apply to actually write.\n");
    return;
  }

  console.log(`\nApplying: PATCH /platform-admin/tenants/${found.id}/plan { plan: "${plan}" } ...`);
  await updateTenantPlan(base, adminToken, found.id, plan);
  console.log("Write complete.");

  await printResolved(base, adminToken, found.id, "New resolved");
}

main().catch((e) => {
  console.error("set-e2e-tenant-plan failed:", e.message);
  process.exitCode = 1;
});
