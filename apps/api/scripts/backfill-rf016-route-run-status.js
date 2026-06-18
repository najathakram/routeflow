/**
 * backfill-rf016-route-run-status.js
 * ───────────────────────────────────
 * One-shot backfill for RF-016: marks every RouteRun as COMPLETED when all its
 * RouteRunStops are in {COMPLETED, SKIPPED}. The auto-flip trigger added in
 * commit c7fb978 fires inside completeStop(), so it only catches NEW
 * completions; runs whose stops were finished BEFORE that commit deployed
 * stay stuck in IN_PROGRESS forever. This script self-heals them.
 *
 * Idempotent — re-running after no rows match is safe (prints "nothing to do").
 *
 * Run from repo root:
 *   DATABASE_URL="postgresql://…" node apps/api/scripts/backfill-rf016-route-run-status.js
 */

"use strict";

const { Client } = require("pg");

function ok(m) {
  console.log(`   ✓ ${m}`);
}
function info(m) {
  console.log(`   • ${m}`);
}
function step(m) {
  console.log(`\n${"─".repeat(60)}\n  ${m}`);
}

async function main() {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    step("Connecting to DB…");
    await pg.connect();
    ok("Connected");

    // Find candidate runs: SCHEDULED or IN_PROGRESS only (NOT CANCELLED — that's
    // a terminal state and must not be auto-flipped). Every stop must be
    // COMPLETED|SKIPPED, and the run must have at least one stop.
    step("Locating runs with all stops finished but run.status != COMPLETED…");
    const cand = await pg.query(`
      SELECT r.id, r.status, COUNT(s.id)::int AS stop_count
      FROM "RouteRun" r
      JOIN "RouteRunStop" s ON s."routeRunId" = r.id
      WHERE r.status IN ('SCHEDULED', 'IN_PROGRESS')
      GROUP BY r.id
      HAVING COUNT(*) FILTER (WHERE s.status NOT IN ('COMPLETED','SKIPPED')) = 0
         AND COUNT(s.id) > 0
    `);

    if (cand.rows.length === 0) {
      info("No matching runs — nothing to do.");
      return;
    }

    info(`Found ${cand.rows.length} run(s) needing the auto-flip:`);
    for (const r of cand.rows) {
      info(`  • run id=${r.id}  status=${r.status}  stops=${r.stop_count}`);
    }

    step("Updating RouteRun.status → COMPLETED + setting completedAt = now()…");
    const upd = await pg.query(
      `
      UPDATE "RouteRun" r
      SET status = 'COMPLETED',
          "completedAt" = COALESCE(r."completedAt", now()),
          "updatedAt" = now()
      WHERE r.id = ANY($1::text[])
      RETURNING r.id, r."completedAt"
    `,
      [cand.rows.map((r) => r.id)],
    );

    ok(`Updated ${upd.rowCount} RouteRun row(s).`);
    for (const u of upd.rows) {
      info(`  ✓ ${u.id}  completedAt=${u.completedAt.toISOString()}`);
    }
  } catch (e) {
    console.error("[backfill-rf016] Fatal:", e.message);
    process.exit(1);
  } finally {
    await pg.end();
  }
}

main();
