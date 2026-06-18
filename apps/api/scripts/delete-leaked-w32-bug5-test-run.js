/**
 * Delete W32-BUG5-TEST Zero-Stop Run
 * -----------------------------------
 * NEW-m1-2: Deletes the leaked W32-BUG5-TEST zero-stop run from the ux-audit test tenant.
 * This script is idempotent—safe to run multiple times.
 *
 * Run from repo root:
 *   node apps/api/scripts/delete-leaked-w32-bug5-test-run.js
 *
 * Safety:
 *   - Targets only the specific run by name (W32-BUG5-TEST) in the ux-audit tenant
 *   - Does NOT execute without explicit user confirmation
 *   - Idempotent: safe to run multiple times (checks existence first)
 *   - Deletes run and all associated RouteRunStops in CASCADE order
 */

"use strict";
const { Client } = require("pg");
const readline = require("readline");

// ── Config ────────────────────────────────────────────────────────────────────

const DB_URL = "postgresql://routeflow:routeflow_prod_2026@gondola.proxy.rlwy.net:41006/routeflow";
const UX_AUDIT_TENANT_ID = "8ee7bbf5-991b-41b1-adcb-4a6c20981401"; // tenantId UUID for ux-audit-1777265477001
const TARGET_RUN_NAME = "W32-BUG5-TEST";

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(msg) {
  console.log(`   ✓ ${msg}`);
}
function warn(msg) {
  console.log(`   ⚠  ${msg}`);
}
function err(msg) {
  console.log(`   ✗ ${msg}`);
}
function step(msg) {
  console.log(`\n${"─".repeat(60)}\n  ${msg}`);
}

async function confirm(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n${msg} (yes/no): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const pg = new Client({ connectionString: DB_URL });

  try {
    step("Connecting to database...");
    await pg.connect();
    ok("Connected");

    // Step 1: Find the run by name in the ux-audit tenant
    step("Locating W32-BUG5-TEST run in ux-audit tenant...");
    const routeResult = await pg.query(
      `SELECT id, name, "driverId", status FROM "Route"
       WHERE "tenantId" = $1 AND name = $2 LIMIT 1`,
      [UX_AUDIT_TENANT_ID, TARGET_RUN_NAME],
    );

    if (routeResult.rows.length === 0) {
      warn(`No route named "${TARGET_RUN_NAME}" found in ux-audit tenant`);
      step("Exiting (idempotent: nothing to delete)");
      ok("Complete");
      await pg.end();
      return;
    }

    const route = routeResult.rows[0];
    ok(`Found Route: id=${route.id}, name=${route.name}, status=${route.status}`);

    // Step 2: Find associated route runs
    step("Locating associated RouteRuns...");
    const runsResult = await pg.query(
      `SELECT id, status FROM "RouteRun"
       WHERE "routeId" = $1 AND "tenantId" = $2`,
      [route.id, UX_AUDIT_TENANT_ID],
    );

    if (runsResult.rows.length === 0) {
      warn("No RouteRuns found for this route");
    } else {
      ok(`Found ${runsResult.rows.length} RouteRun(s)`);
      for (const run of runsResult.rows) {
        warn(`  - RouteRun id=${run.id}, status=${run.status}`);
      }
    }

    // Step 3: Collect all IDs to delete
    const runIds = runsResult.rows.map((r) => r.id);

    // Find all stops for those runs
    let stopIds = [];
    if (runIds.length > 0) {
      const stopsResult = await pg.query(
        `SELECT id FROM "RouteRunStop" WHERE "routeRunId" = ANY($1::text[])`,
        [runIds],
      );
      stopIds = stopsResult.rows.map((s) => s.id);
      if (stopIds.length > 0) {
        ok(`Found ${stopIds.length} RouteRunStop(s) to cascade-delete`);
      }
    }

    // Step 4: Show summary and request confirmation
    step("Summary of changes:");
    warn(`  Route:      1 (id=${route.id})`);
    warn(`  RouteRuns:  ${runIds.length}`);
    warn(`  Stops:      ${stopIds.length} (will cascade-delete)`);

    const shouldProceed = await confirm(
      "Proceed with deletion? This will permanently remove the route and all associated stops.",
    );

    if (!shouldProceed) {
      step("Cancelled by user");
      ok("No changes made");
      await pg.end();
      return;
    }

    // Step 5: Execute deletion in cascade order
    step("Executing deletion...");

    // Delete RouteRunStop records first (no FK constraints)
    if (stopIds.length > 0) {
      const delStopsResult = await pg.query(
        `DELETE FROM "RouteRunStop" WHERE id = ANY($1::text[]) RETURNING id`,
        [stopIds],
      );
      ok(`Deleted ${delStopsResult.rowCount} RouteRunStop records`);
    }

    // Delete RouteRun records
    if (runIds.length > 0) {
      const delRunsResult = await pg.query(
        `DELETE FROM "RouteRun" WHERE id = ANY($1::text[]) RETURNING id`,
        [runIds],
      );
      ok(`Deleted ${delRunsResult.rowCount} RouteRun records`);
    }

    // Delete the Route record
    const delRouteResult = await pg.query(`DELETE FROM "Route" WHERE id = $1 RETURNING id`, [
      route.id,
    ]);
    ok(`Deleted ${delRouteResult.rowCount} Route record`);

    step("Success!");
    ok("W32-BUG5-TEST run and all associated records removed from ux-audit tenant");
  } catch (err) {
    step("Error!");
    err(err.message);
    process.exit(1);
  } finally {
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
