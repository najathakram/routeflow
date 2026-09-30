#!/usr/bin/env node
/**
 * Google sign-in reachability monitor (OPS-23/DECIDE-29, dev-pipeline
 * 2026-09-11-google-signin-monitor WP2). Runs checkGoogleSignIn + checkApexDns against
 * SMOKE_BASE_URL on a schedule (see .github/workflows/google-signin-monitor.yml) so a
 * deleted/misconfigured Google OAuth client is caught within 6h instead of by a human
 * noticing sign-in is dead. Never signs in, never touches Google credentials/cookies.
 *
 * Env vars:
 *   SMOKE_BASE_URL     — API base URL (default: prod API)
 *   SMOKE_TENANT_SLUG  — tenant slug for the tenant door (default: e2e-routeflow), asserted
 *                        against the test-tenant policy before use.
 *   SMOKE_TIMEOUT_MS   — shared timeout budget in ms (default: 15000)
 */

import { assertTestTenant } from "./lib/test-tenants.cjs";
import { checkGoogleSignIn, checkApexDns } from "./lib/google-signin-check.mjs";

const BASE = (
  process.env.SMOKE_BASE_URL || "https://routeflowapi-production.up.railway.app"
).replace(/\/+$/, "");
const TENANT = assertTestTenant(
  process.env.SMOKE_TENANT_SLUG || "e2e-routeflow",
  "google-signin-monitor",
);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 15_000);

async function run() {
  console.log(`\n🔎 Google sign-in monitor — ${BASE} (tenant: ${TENANT})\n`);
  let failures = 0;

  try {
    const result = await checkGoogleSignIn({
      baseUrl: BASE,
      tenant: TENANT,
      timeoutMs: TIMEOUT_MS,
    });
    for (const door of result.doors) {
      if (door.status === "ok") {
        console.log(`  ✅ google-signin: ${door.name} — ${door.finalPage}`);
      } else if (door.status === "skipped") {
        console.log(`  ⚠️  google-signin: ${door.name} — skipped (${door.reason})`);
      } else {
        console.log(
          `  ❌ google-signin: ${door.name} — ${door.reason}${door.finalPage ? ` (${door.finalPage})` : ""}`,
        );
        failures++;
      }
    }
  } catch (err) {
    console.log(`  ❌ google-signin: ${err?.message ?? err}`);
    failures++;
  }

  try {
    const required = process.env.SMOKE_APEX_REQUIRED === "1";
    const result = await checkApexDns({ hostname: "routeflow.info", required });
    if (result.status === "ok") {
      console.log(`  ✅ apex-dns: routeflow.info — resolved (${result.address})`);
    } else if (result.status === "warn") {
      console.log(`  ⚠️  apex-dns: routeflow.info — ${result.reason}`);
    } else {
      console.log(`  ❌ apex-dns: routeflow.info — ${result.reason}`);
      failures++;
    }
  } catch (err) {
    console.log(`  ❌ apex-dns: ${err?.message ?? err}`);
    failures++;
  }

  console.log("");
  if (failures > 0) {
    console.error(
      `💥 Google sign-in monitor FAILED — ${failures} check(s) failed against ${BASE}\n`,
    );
    process.exit(1);
  }
  console.log(`✨ Google sign-in monitor passed (${BASE})\n`);
}

run().catch((err) => {
  console.error("💥 Google sign-in monitor crashed:", err);
  process.exit(1);
});
