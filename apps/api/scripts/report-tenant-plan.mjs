#!/usr/bin/env node
/**
 * B450 — read-only report of a tenant's plan state: the legacy `Tenant.plan` enum, the
 * raw `TenantSubscription` row, and the RESOLVED planKey + flags (what the tenant's own
 * dashboard actually sees) — via the real platform-admin/billing API, never a raw DB
 * connection or a hand-rolled mirror of `EntitlementsService` (see
 * `apps/api/scripts/lib/platform-admin-http.mjs`'s header for why).
 *
 * Written to diagnose why `e2e-routeflow` 403s on `POST /recurring-invoices` in the
 * post-deploy E2E since #777: its legacy `Tenant.plan` ("PROFESSIONAL") maps to SCALE
 * (fully-featured), but if a `TenantSubscription.planKey` row pins it to LITE instead,
 * that wins — this report makes that visible without guessing.
 *
 * Usage:
 *   API_URL=https://routeflowapi-production-....up.railway.app/api/v1 \
 *   SUPER_ADMIN_USERNAME=... SUPER_ADMIN_PASSWORD=... \
 *   node apps/api/scripts/report-tenant-plan.mjs e2e-routeflow
 *
 * API_URL defaults to http://localhost:3000/api/v1 (printed either way) — this hits a
 * RUNNING API process over HTTP, so `railway run` (a DB tunnel) is not the right
 * invocation here; point API_URL at the deployed Railway URL instead.
 *
 * Not restricted to approved test tenants — this is a read (a platform-admin could
 * already see this in the dashboard), not a test/seed/cleanup action. The companion
 * WRITE script (`set-e2e-tenant-plan.mjs`) IS hard-restricted.
 */
import {
  resolveApiBase,
  loginAsSuperAdmin,
  findTenantBySlug,
  getTenantDetail,
  getResolvedSubscription,
  LITE_L2_FLAGS,
} from "./lib/platform-admin-http.mjs";

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: node apps/api/scripts/report-tenant-plan.mjs <slug>");
    process.exit(1);
  }

  const base = resolveApiBase();
  const adminToken = await loginAsSuperAdmin(base);

  const found = await findTenantBySlug(base, adminToken, slug);
  const detail = await getTenantDetail(base, adminToken, found.id);
  const resolved = await getResolvedSubscription(base, adminToken, found.id);

  console.log(`\n=== TENANT PLAN REPORT — ${slug} (${found.id}) ===\n`);

  console.log("Legacy Tenant.plan enum:", detail.plan);
  console.log("Tenant.status:          ", detail.status);

  console.log("\nTenantSubscription row:");
  if (!detail.subscription) {
    console.log("  (none — planKey falls back to planKeyFromEnum(Tenant.plan) above)");
  } else {
    console.log("  planKey:            ", detail.subscription.planKey);
    console.log("  currentPlan:        ", detail.subscription.currentPlan);
    console.log("  cycle:              ", detail.subscription.cycle);
    console.log("  cancelAtPeriodEnd:  ", detail.subscription.cancelAtPeriodEnd);
    console.log("  downgradeToPlanKey: ", detail.subscription.downgradeToPlanKey ?? "(none)");
    console.log("  periodEnd:          ", detail.subscription.periodEnd);
  }

  console.log("\nResolved (what the tenant's own dashboard sees, via /billing/subscription):");
  console.log("  planKey: ", resolved.planKey);
  console.log("  planName:", resolved.planName);
  console.log("  status:  ", resolved.status);

  console.log("\nLite-L2 flags:");
  const flags = resolved.flags ?? [];
  for (const flag of LITE_L2_FLAGS) {
    console.log(`  ${flags.includes(flag) ? "✓ granted" : "✗ MISSING"}  ${flag}`);
  }
  console.log(`\nAll resolved flags (${flags.length}): ${flags.join(", ") || "(none)"}`);

  console.log(
    "\n=== END — no writes were made (impersonation-issuance is audit-logged by the API itself) ===\n",
  );
}

main().catch((e) => {
  console.error("report failed:", e.message);
  process.exitCode = 1;
});
