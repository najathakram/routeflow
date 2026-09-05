/**
 * repair-f25-licence-dates.mjs — D6 repair flight for campaign batch F25
 * (bug B91's writer half).
 *
 * Before the F25 fix, the mobile-operator licence-renewal form
 * (`apps/mobile/app/(operator)/customers/[id]/licenses.logic.ts`) wrote a
 * `CustomerAuthorization.expiresAt` as a LOCAL `${date}T23:59:59` instant
 * instead of the schema's UTC-midnight storage convention. This script finds
 * every row still carrying that damage and rewrites `expiresAt` to the
 * UTC-midnight instant of the calendar day the row actually meant.
 *
 * The day is recovered by `scripts/lib/recover-calendar-day.cjs`, which reads
 * ONLY the stored instant's UTC time-of-day: before noon ⇒ the intended day is
 * the previous UTC day, noon or later ⇒ the UTC day itself. The damage was
 * written in the WRITING DEVICE's timezone, which is unrelated to the tenant's
 * — recovering through `TenantConfig.timezone` would land a day late for every
 * device west of the tenant zone, so the tenant zone is printed for
 * information only and never used to work out the day. See that module's
 * header for the derivation and its validity range (device offsets UTC−12:00
 * through UTC+11:59:59).
 *
 * SCOPE (derived from `scripts/report-f25-licence-dates.mjs`'s scan, never
 * hardcoded ids): every `CustomerAuthorization` row whose `expiresAt` is
 * NOT NULL and is not exactly UTC midnight (`00:00:00.000`) — the same test
 * `recoverCalendarDay` uses to decide a row needs no recovery.
 *
 * WHAT IS REPAIRED
 *   Per affected row, in ONE transaction: `expiresAt` → the UTC-midnight
 *   instant of `recoverCalendarDay(storedIso)`. Nothing else on the row is
 *   touched. A row `recoverCalendarDay` reports as `null` (already UTC
 *   midnight, or an unparseable instant) is skipped — it is not damage this
 *   script repairs.
 *
 * ⚠️ THE WRITE MOVES `expiresAt` EARLIER IN ABSOLUTE TIME — up to ~36 h
 *   earlier for a UTC−12 device (the shift is `23:59:59` plus the writing
 *   device's west-of-UTC offset; the repo's own PDT (UTC−7) fixture in
 *   `apps/api/src/common/recover-calendar-day.spec.ts` moves 31 h).
 *   `expiresAt` is not display-only: `authorization-expiry.service.ts` sweeps
 *   `{ status: VERIFIED, expiresAt: { lt: now } }` and flips those rows to
 *   EXPIRED — writing an audit entry, notifying operators and firing
 *   LICENSE_EXPIRING to the CUSTOMER — and
 *   `authorization-guard.service.ts` blocks regulated sales on
 *   `expiresAt < now`. So a row that is valid RIGHT NOW but whose recovered
 *   UTC-midnight instant is already in the past would be silently killed by
 *   this repair. Such rows are classified `EXPIRING NOW`, listed under their
 *   own banner in the dry run, and SKIPPED by `--execute` unless
 *   `--allow-expiring-rows` is also passed. That classification is recomputed
 *   from a FRESH clock after the confirmation prompt returns (the plan-time
 *   snapshot is preview-only), so a run that straddles a UTC midnight cannot
 *   slip a newly-expiring row past the gate.
 *
 * ⚠️ ROWS FROM UTC+12…+14 DEVICES COME OUT ONE DAY EARLY.
 *   `recoverCalendarDay`'s before-noon rule is a correct recovery only for
 *   device offsets UTC−12:00…UTC+11:59:59. A device further east (Pacific/
 *   Auckland in DST is UTC+13) stores its local 23:59:59 as a UTC time-of-day
 *   BEFORE noon, which the rule reads as the previous day — and that is
 *   indistinguishable from a genuine previous-day write by a UTC−10…−12
 *   device. Rows whose stored UTC time-of-day falls in [09:00:00, 12:00:00)
 *   are therefore classified `FAR EAST / AMBIGUOUS`, listed under their own
 *   banner, and SKIPPED by `--execute` unless `--allow-far-east-rows` is also
 *   passed. Confirm the intended day with the tenant and repair those rows
 *   individually instead.
 *
 * TEST-TENANT GATE (CLAUDE.md "Test tenants & real-client data policy")
 *   Unlike `repair-f11-stranded-orders.mjs` (a D4 lane that repairs live rows
 *   by design), this D6 script defaults to the project's standard test-tenant
 *   gate: `--tenant` must resolve to an approved test tenant
 *   (`scripts/lib/test-tenants.cjs`'s `assertTestTenant`) unless
 *   `--live-tenant-override` is also passed — and a live tenant additionally
 *   requires the type-back confirmation (the same gate
 *   `scripts/enable-developer-mode.mjs` uses), on top of `--execute` and the
 *   backup attestation below.
 *
 * SAFETY MODEL (house pattern — mirrors scripts/repair-f11-stranded-orders.mjs)
 *   • DRY RUN BY DEFAULT: session forced `default_transaction_read_only = on`;
 *     prints every affected row, its recovered day, and the exact SQL
 *     (with --verbose).
 *   • Writing requires ALL of:
 *       --execute                   turn writes on
 *       --i-have-a-fresh-backup     attest a fresh VERIFIED backup exists
 *       --tenant <slug>              required — this script never repairs
 *                                    across every tenant in one run
 *       --live-tenant-override      required IF --tenant is not an approved
 *                                    test tenant, plus the type-back prompt
 *       --allow-expiring-rows       required to write a row whose repair would
 *                                    move a CURRENTLY-VALID licence into the
 *                                    past (see the warning above); without it
 *                                    those rows are listed and skipped
 *       --allow-far-east-rows       required to write a row whose stored UTC
 *                                    time-of-day is in [09:00, 12:00) — the
 *                                    UTC+12…+14 band the recovery rule reads
 *                                    one day early; without it those rows are
 *                                    listed and skipped
 *   • One transaction PER ROW: the row is locked (SELECT … FOR UPDATE) and
 *     its `expiresAt` re-read and compared to the dry-run snapshot inside the
 *     transaction; any drift aborts that row's transaction and moves on.
 *   • Every executed repair appends one JSONL line to
 *     local-assets/f25-repair-<ts>.jsonl:
 *       { authId, tenantId, expiringNow, farEast,
 *         before: { expiresAt, status, expiryNotifiedAt },
 *         after: { expiresAt } }
 *     — the before-state there is the rollback source (REPAIR-RUNBOOK.md §4).
 *     `status`/`expiryNotifiedAt` are captured under the same lock so a
 *     rollback can also undo an EXPIRED flip the cron made in the meantime.
 *   • Refuses to run unless current_database() is 'railway' or 'routeflow' —
 *     pass --force-nonprod to run elsewhere (loud, deliberate; this is also
 *     how the builder verification runs against a local docker Postgres).
 *   • Prints ids and timestamps only — never customer, licensee, or business
 *     names.
 *
 * Usage:
 *   node scripts/repair-f25-licence-dates.mjs --tenant test
 *   node scripts/repair-f25-licence-dates.mjs --tenant test --verbose
 *   node scripts/repair-f25-licence-dates.mjs \
 *     --tenant test --execute --i-have-a-fresh-backup --confirm-all-listed
 *   node scripts/repair-f25-licence-dates.mjs \
 *     --tenant test --execute --i-have-a-fresh-backup --confirm-all-listed \
 *     --allow-expiring-rows
 *   railway run --service postgres node scripts/repair-f25-licence-dates.mjs \
 *     --tenant <live-slug> --live-tenant-override --execute --i-have-a-fresh-backup \
 *     --confirm-all-listed
 */
import pg from "pg";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestTenant } from "./lib/test-tenants.cjs";
import { recoverCalendarDay, classifyRepairRow } from "./lib/recover-calendar-day.cjs";

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const BACKUP_ATTESTED = argv.includes("--i-have-a-fresh-backup");
const FORCE_NONPROD = argv.includes("--force-nonprod");
const LIVE_TENANT_OVERRIDE = argv.includes("--live-tenant-override");
const CONFIRM_ALL = argv.includes("--confirm-all-listed");
const ALLOW_EXPIRING = argv.includes("--allow-expiring-rows");
const ALLOW_FAR_EAST = argv.includes("--allow-far-east-rows");
const VERBOSE = argv.includes("--verbose");

const tenantIdx = argv.indexOf("--tenant");
const TENANT_SLUG = tenantIdx >= 0 ? argv[tenantIdx + 1] : null;
if (!TENANT_SLUG || TENANT_SLUG.startsWith("--")) {
  console.error(
    "--tenant <slug> is required — this script repairs one tenant per run, never every tenant " +
      "at once. See scripts/report-f25-licence-dates.mjs for the per-tenant scan.",
  );
  process.exit(2);
}

// ─── Test-tenant gate (CLAUDE.md policy) ─────────────────────────────────────
// A live tenant needs the explicit override on top of everything else below —
// mirrors scripts/enable-developer-mode.mjs's gate.
let isLiveTenant = false;
try {
  assertTestTenant(TENANT_SLUG, "repair-f25-licence-dates");
} catch (e) {
  isLiveTenant = true;
  if (!LIVE_TENANT_OVERRIDE) {
    console.error(`\n${e.message}\n`);
    console.error(
      "Repairing a LIVE tenant's licence dates requires the explicit --live-tenant-override " +
        "flag (and still needs --execute, --i-have-a-fresh-backup, and the type-back confirmation).",
    );
    process.exit(1);
  }
}

// ─── Connection resolution (mirrors scripts/repair-f11-stranded-orders.mjs) ──
function resolveUrl() {
  const direct = process.env.DATABASE_URL;
  if (direct && !direct.includes(".railway.internal")) return direct;
  const {
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_DB,
    RAILWAY_TCP_PROXY_DOMAIN,
    RAILWAY_TCP_PROXY_PORT,
  } = process.env;
  if (RAILWAY_TCP_PROXY_DOMAIN && POSTGRES_USER && POSTGRES_PASSWORD) {
    const db = POSTGRES_DB || "railway";
    const port = RAILWAY_TCP_PROXY_PORT || "5432";
    return `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(
      POSTGRES_PASSWORD,
    )}@${RAILWAY_TCP_PROXY_DOMAIN}:${port}/${db}`;
  }
  return direct || null;
}

const url = resolveUrl();
if (!url) {
  console.error(
    "No usable connection string. Set DATABASE_URL, or run via:\n" +
      "  railway run --service postgres node scripts/repair-f25-licence-dates.mjs --tenant <slug>",
  );
  process.exit(2);
}

// The tenant's configured zone is resolved for the banner ONLY — it plays no
// part in recovering a day (see recover-calendar-day.cjs's header).
const TENANT_QUERY = `
  SELECT t.id AS tenant_id, tc.timezone AS tenant_timezone
  FROM "Tenant" t
  LEFT JOIN "TenantConfig" tc ON tc."tenantId" = t.id
  WHERE t.slug = $1
`;

const SCOPE_QUERY = `
  SELECT ca.id AS auth_id, ca."expiresAt" AS expires_at
  FROM "CustomerAuthorization" ca
  WHERE ca."expiresAt" IS NOT NULL AND ca."tenantId" = $1
  ORDER BY ca."expiresAt"
`;

const client = new pg.Client({ connectionString: url });

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exitCode = 1;
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  await client.connect();

  const { rows: dbRows } = await client.query("SELECT current_database() AS db");
  const db = dbRows[0].db;
  if (!["railway", "routeflow"].includes(db) && !FORCE_NONPROD) {
    fail(
      `Refusing to run against database "${db}" — expected 'railway' or 'routeflow'. ` +
        `Pass --force-nonprod to override deliberately.`,
    );
    await client.end();
    return;
  }

  if (!EXECUTE) {
    await client.query("SET default_transaction_read_only = on");
  } else if (!BACKUP_ATTESTED) {
    fail("--execute requires --i-have-a-fresh-backup (attest a fresh VERIFIED backup exists).");
    await client.end();
    return;
  }

  console.log(
    `\nF25 licence-date repair flight — database "${db}" — ${EXECUTE ? "EXECUTE" : "DRY RUN"} ` +
      `— tenant "${TENANT_SLUG}"${isLiveTenant ? " (LIVE — --live-tenant-override)" : ""}`,
  );
  console.log("=".repeat(78));

  const { rows: tenantRows } = await client.query(TENANT_QUERY, [TENANT_SLUG]);
  if (tenantRows.length === 0) {
    fail(`No tenant with slug "${TENANT_SLUG}" — nothing was scanned.`);
    await client.end();
    return;
  }

  const tenantId = tenantRows[0].tenant_id;
  const timeZone = tenantRows[0].tenant_timezone;
  console.log(
    `tenant id ${tenantId}  timezone=${timeZone || "(unset)"} ` +
      `(informational — never used to recover a day)\n`,
  );

  const { rows: scopeRows } = await client.query(SCOPE_QUERY, [tenantId]);
  if (scopeRows.length === 0) {
    console.log(`No licence rows for tenant "${TENANT_SLUG}" — nothing to repair.\n`);
    await client.end();
    return;
  }

  // PREVIEW classification only. `expiringNow` depends on the clock, and the
  // operator prompt below can sit between here and the write for minutes, so
  // the write loop re-classifies against a fresh clock and gates on THAT —
  // never on this snapshot. `farEast` is clock-independent.
  const previewNow = Date.now();
  const plan = [];
  for (const r of scopeRows) {
    const recoveredDay = recoverCalendarDay(r.expires_at);
    if (recoveredDay === null) continue; // already UTC midnight — not damage
    const after = `${recoveredDay}T00:00:00.000Z`;
    const { expiringNow, farEast } = classifyRepairRow(r.expires_at, after, previewNow);
    plan.push({
      authId: r.auth_id,
      before: r.expires_at,
      afterDay: recoveredDay,
      after,
      expiringNow,
      farEast,
    });
  }

  const plainRows = plan.filter((p) => !p.expiringNow && !p.farEast);
  const expiringRows = plan.filter((p) => p.expiringNow);
  const farEastRows = plan.filter((p) => p.farEast);

  const printRow = (p) =>
    console.log(
      `  ${p.authId}  ${new Date(p.before).toISOString()} → ${p.after}` +
        (VERBOSE
          ? `\n    SQL: UPDATE "CustomerAuthorization" SET "expiresAt"='${p.after}' WHERE id='${p.authId}';`
          : ""),
    );

  console.log(
    `Rows to repair: ${plan.length} (${plainRows.length} plain, ${expiringRows.length} expiring now, ` +
      `${farEastRows.length} far-east/ambiguous)\n`,
  );
  if (plan.length === 0) {
    console.log("  (nothing to repair)");
  }
  if (plainRows.length > 0) {
    console.log("PLAIN — already expired before and after, or still valid after the repair:");
    plainRows.forEach(printRow);
  }
  if (expiringRows.length > 0) {
    console.log(`\n${"!".repeat(78)}`);
    console.log(
      `EXPIRING NOW — ${expiringRows.length} row(s) are VALID at this instant and would be moved\n` +
        `INTO THE PAST by the repair. Writing them makes the authorization-expiry cron flip the\n` +
        `licence to EXPIRED, write an audit entry, notify operators and fire LICENSE_EXPIRING to\n` +
        `the CUSTOMER; authorization-guard.service.ts then BLOCKS that customer's regulated sales.\n` +
        `They are SKIPPED unless --allow-expiring-rows is passed. Renewing the licence in the app\n` +
        `is usually the right move instead — see scripts/REPAIR-RUNBOOK.md.`,
    );
    console.log(`${"!".repeat(78)}`);
    expiringRows.forEach(printRow);
  }
  if (farEastRows.length > 0) {
    console.log(`\n${"!".repeat(78)}`);
    console.log(
      `FAR EAST / AMBIGUOUS — ${farEastRows.length} row(s) carry a stored UTC time-of-day in\n` +
        `[09:00:00, 12:00:00). That is the band a device at UTC+12…+14 (Pacific/Auckland in DST is\n` +
        `UTC+13) writes its local 23:59:59 into, and the recovery rule reads it as the PREVIOUS day —\n` +
        `ONE DAY EARLY on the field authorization-guard.service.ts uses to block regulated sales. It is\n` +
        `indistinguishable from a genuine previous-day write by a UTC−10…−12 device, so the day cannot\n` +
        `be recovered from the row alone. They are SKIPPED unless --allow-far-east-rows is passed.\n` +
        `Confirm the intended day with the tenant and repair these rows individually instead.`,
    );
    console.log(`${"!".repeat(78)}`);
    farEastRows.forEach(printRow);
  }

  if (!EXECUTE) {
    console.log(
      `\nDry run complete. To repair: --execute --i-have-a-fresh-backup ` +
        `${isLiveTenant ? "--live-tenant-override " : ""}--confirm-all-listed` +
        `${expiringRows.length > 0 ? " [--allow-expiring-rows]" : ""}` +
        `${farEastRows.length > 0 ? " [--allow-far-east-rows]" : ""}`,
    );
    await client.end();
    return;
  }

  if (plan.length === 0) {
    console.log("\nNothing to change.\n");
    await client.end();
    return;
  }

  if (!CONFIRM_ALL) {
    fail("--execute requires --confirm-all-listed (repair applies to every row listed above).");
    await client.end();
    return;
  }

  if (isLiveTenant) {
    const answer = await confirm(
      `\nType the tenant slug "${TENANT_SLUG}" exactly to proceed (or anything else to abort): `,
    );
    if (answer !== TENANT_SLUG) {
      console.log("\nAborted.\n");
      process.exitCode = 3;
      await client.end();
      return;
    }
  }

  const logDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "local-assets");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(
    logDir,
    `f25-repair-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );
  const append = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");

  // The gate's clock. Taken AFTER the type-back prompt returned, immediately
  // before the first write: the plan above may have been printed and read
  // minutes ago, and a run that straddles a UTC midnight turns a row that
  // previewed as PLAIN into one whose repaired value is now in the past.
  // Gating on the preview snapshot would write that row ungated.
  const writeNow = Date.now();
  const planned = plan.map((p) => ({
    ...p,
    expiringNow: classifyRepairRow(p.before, p.after, writeNow).expiringNow,
  }));
  const newlyExpiring = planned.filter((p, i) => p.expiringNow && !plan[i].expiringNow);
  if (newlyExpiring.length > 0) {
    console.log(
      `\n⚠ ${newlyExpiring.length} row(s) became EXPIRING NOW between the plan and this write ` +
        `(clock moved past their recovered day). They are gated as such:`,
    );
    newlyExpiring.forEach(printRow);
    console.log("");
  }

  let repaired = 0;
  let skipped = 0;
  let heldBack = 0;
  let heldBackFarEast = 0;
  for (const p of planned) {
    if (p.expiringNow && !ALLOW_EXPIRING) {
      console.log(`  ⏸ ${p.authId} → ${p.after}  HELD BACK (expiring now; --allow-expiring-rows)`);
      heldBack++;
      continue;
    }
    if (p.farEast && !ALLOW_FAR_EAST) {
      console.log(
        `  ⏸ ${p.authId} → ${p.after}  HELD BACK (far-east/ambiguous; --allow-far-east-rows)`,
      );
      heldBackFarEast++;
      continue;
    }
    try {
      await client.query("BEGIN");
      const { rows: locked } = await client.query(
        `SELECT "expiresAt", "status", "expiryNotifiedAt" FROM "CustomerAuthorization" WHERE id = $1 FOR UPDATE`,
        [p.authId],
      );
      if (locked.length === 0) throw new Error("row vanished");
      if (new Date(locked[0].expiresAt).toISOString() !== new Date(p.before).toISOString()) {
        throw new Error("expiresAt drifted since the dry run");
      }
      await client.query(`UPDATE "CustomerAuthorization" SET "expiresAt" = $2 WHERE id = $1`, [
        p.authId,
        p.after,
      ]);
      await client.query("COMMIT");
      append({
        authId: p.authId,
        tenantId,
        expiringNow: p.expiringNow,
        farEast: p.farEast,
        before: {
          expiresAt: p.before,
          status: locked[0].status,
          expiryNotifiedAt: locked[0].expiryNotifiedAt,
        },
        after: { expiresAt: p.after },
      });
      console.log(`  ✓ ${p.authId} → ${p.after}${p.expiringNow ? "  (was expiring now)" : ""}`);
      repaired++;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      fail(`${p.authId}: aborted — ${e.message}`);
      skipped++;
    }
  }

  console.log(
    `\nRepaired ${repaired} row(s), aborted ${skipped} row(s), held back ${heldBack} ` +
      `expiring-now row(s) and ${heldBackFarEast} far-east/ambiguous row(s). Log: ${logPath}`,
  );
  if (heldBack > 0) {
    console.log(
      `Re-run with --allow-expiring-rows to write the held-back rows — but read the EXPIRING NOW\n` +
        `banner above first: doing so expires those licences and blocks the customers' regulated sales.`,
    );
  }
  if (heldBackFarEast > 0) {
    console.log(
      `Re-run with --allow-far-east-rows to write the far-east rows — but read the FAR EAST banner\n` +
        `above first: for a UTC+12…+14 writer those land ONE DAY EARLY. Confirm the intended day with\n` +
        `the tenant and repair them individually instead.`,
    );
  }
  await client.end();
}

main().catch(async (e) => {
  console.error(e);
  await client.end().catch(() => {});
  process.exit(1);
});
