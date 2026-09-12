#!/usr/bin/env node
/**
 * GoHighLevel CRM connector — manual sandbox check (build-plan.md WP5, spec R32/R33).
 *
 * NOT a Jest suite and NOT in any gate — it needs a live GoHighLevel sandbox location
 * and Private Integration Token, which CI never has. Run it by hand against a local or
 * deployed API after connecting a sandbox account, to sanity-check the whole flow one
 * time before onboarding a real client.
 *
 * SAFETY (non-negotiable, in this order):
 *   1. Prints the resolved host BEFORE any network call (lesson L-074: a prod-capable
 *      script must never resolve its target silently).
 *   2. `assertTestTenant()` — refuses to run against anything but an approved test
 *      tenant (see scripts/lib/test-tenants.cjs); `SMOKE_TENANT_SLUG` defaults to `test`.
 *   3. Never mutates the connection's persisted config beyond what saving/testing it
 *      requires; never disconnects an existing connection.
 *
 * What it does:
 *   1. Logs in as the tenant's operator.
 *   2. Saves a GoHighLevel connection from GHL_SANDBOX_TOKEN/GHL_SANDBOX_LOCATION_ID and
 *      confirms Save & test reports the sandbox location name (R2).
 *   3. Reads GET /crm/gohighlevel/pipelines and confirms at least one pipeline comes back.
 *   4. Calls POST /crm/gohighlevel/sync (the same route the Settings tab's "Check now" button
 *      uses) to run one poll immediately, then confirms GET /crm/gohighlevel/handoffs recorded
 *      at least one handoff row for a lead already sitting in the sandbox at the connected
 *      stage — proving the end-to-end read path without RouteFlow ever writing back.
 *
 * Env vars:
 *   SMOKE_BASE_URL           — API base URL (default: http://localhost:3000)
 *   SMOKE_TENANT_SLUG        — tenant slug for operator login (default: test)
 *   SMOKE_OPERATOR_USERNAME  — operator username (default: admin)
 *   SMOKE_OPERATOR_PASSWORD  — operator password (default: Admin@123)
 *   SMOKE_TIMEOUT_MS         — per-request timeout in ms (default: 20000)
 *   GHL_SANDBOX_TOKEN        — GoHighLevel Private Integration Token (required)
 *   GHL_SANDBOX_LOCATION_ID  — GoHighLevel location id (required)
 */

import { assertTestTenant } from "../../../scripts/lib/test-tenants.cjs";

const BASE = (process.env.SMOKE_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
// Only approved test tenants may be checked against — never a live client tenant.
const TENANT = assertTestTenant(process.env.SMOKE_TENANT_SLUG || "test", "crm-gohighlevel-check");
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 20_000);
const OP_USER = process.env.SMOKE_OPERATOR_USERNAME || "admin";
const OP_PASS = process.env.SMOKE_OPERATOR_PASSWORD || "Admin@123";
const GHL_TOKEN = process.env.GHL_SANDBOX_TOKEN;
const GHL_LOCATION_ID = process.env.GHL_SANDBOX_LOCATION_ID;

let TOKEN = null;
let failures = 0;

function pass(msg) {
  console.log(`  ✅ ${msg}`);
}
function fail(msg) {
  console.error(`  ❌ ${msg}`);
  failures++;
}
function section(name) {
  console.log(`\n── ${name} ──`);
}

async function withTimeout(fn, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

async function req(method, path, body) {
  const headers = { accept: "application/json", "x-tenant-slug": TENANT };
  if (TOKEN) headers["authorization"] = `Bearer ${TOKEN}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await withTimeout((signal) =>
    fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    }),
  );
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body — leave json null, caller sees res.ok/status
  }
  return { status: res.status, ok: res.ok, body: json, raw: text };
}

async function login() {
  const res = await req("POST", "/api/v1/auth/login", {
    username: OP_USER,
    password: OP_PASS,
  });
  if (!res.ok || !res.body?.accessToken) {
    throw new Error(`Login failed (${res.status}): ${res.raw}`);
  }
  TOKEN = res.body.accessToken;
}

async function main() {
  // Lesson L-074: resolve and print the target BEFORE any network call — never a silent default.
  console.log(`crm-gohighlevel-check: target=${BASE} tenant=${TENANT}`);

  if (!GHL_TOKEN || !GHL_LOCATION_ID) {
    console.error(
      "GHL_SANDBOX_TOKEN and GHL_SANDBOX_LOCATION_ID are required — see docs/runbooks/gohighlevel-client-setup.md.",
    );
    process.exitCode = 1;
    return;
  }

  section("Login");
  await login();
  pass(`Logged in as ${OP_USER}@${TENANT}`);

  section("Save & test connection");
  const saved = await req("PATCH", "/api/v1/crm/gohighlevel/connection", {
    token: GHL_TOKEN,
    locationId: GHL_LOCATION_ID,
  });
  if (saved.ok) {
    pass("Connection saved");
  } else {
    fail(`Save connection failed (${saved.status}): ${saved.raw}`);
  }

  const tested = await req("POST", "/api/v1/crm/gohighlevel/connection/test");
  if (tested.ok && tested.body?.locationName) {
    pass(`Test connection reports location "${tested.body.locationName}"`);
  } else if (tested.ok) {
    fail(`Test connection succeeded but returned no locationName: ${tested.raw}`);
  } else {
    fail(`Test connection failed (${tested.status}): ${tested.raw}`);
  }

  section("Pipelines");
  const pipelines = await req("GET", "/api/v1/crm/gohighlevel/pipelines");
  if (pipelines.ok && Array.isArray(pipelines.body) && pipelines.body.length > 0) {
    pass(`Found ${pipelines.body.length} pipeline(s)`);
  } else if (pipelines.ok) {
    fail(
      "Pipelines call succeeded but returned none — connect a sandbox account with at least one pipeline",
    );
  } else {
    fail(`Pipelines call failed (${pipelines.status}): ${pipelines.raw}`);
  }

  section("Sync now");
  const synced = await req("POST", "/api/v1/crm/gohighlevel/sync");
  if (synced.ok) {
    pass(
      `Sync ran: ${synced.body?.new ?? 0} new, ${synced.body?.created ?? 0} created, ` +
        `${synced.body?.linked ?? 0} linked, ${synced.body?.needsReview ?? 0} need review`,
    );
  } else {
    fail(`Sync failed (${synced.status}): ${synced.raw}`);
  }

  section("Handoff row recorded");
  const handoffs = await req("GET", "/api/v1/crm/gohighlevel/handoffs?limit=1");
  if (handoffs.ok && Array.isArray(handoffs.body?.data) && handoffs.body.data.length > 0) {
    pass("At least one handoff row recorded");
  } else if (handoffs.ok) {
    fail(
      "No handoff row appeared — make sure the connection is enabled, a stage/trigger is " +
        "configured, and the sandbox has a lead at that stage created after the connection's startFrom date",
    );
  } else {
    fail(`Handoffs call failed (${handoffs.status}): ${handoffs.raw}`);
  }

  console.log(`\n${failures === 0 ? "✅ All checks passed" : `❌ ${failures} check(s) failed`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("crm-gohighlevel-check crashed:", err);
  process.exitCode = 1;
});
