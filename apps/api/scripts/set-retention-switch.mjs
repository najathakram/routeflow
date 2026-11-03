/**
 * SA-1083 A-4: turns one retention job's switch on or off, with its audit row in the same transaction. A dry run unless
 * `--apply`. `--on` refuses unless the job's run rows, read back from today, have stayed in report mode for 7 days.
 * `--off` has no conditions. The job reads its switch once per run, so a change takes effect at its next run.
 *
 *   node apps/api/scripts/set-retention-switch.mjs --job demo-bookings --off --reason "<why>"            (dry run)
 *   railway run --service postgres node apps/api/scripts/set-retention-switch.mjs --job demo-bookings --on --reason "<why>" --apply
 *
 * SAFETY: writes one `PlatformConfig` key and one `AuditLog` row with no tenant, and no tenant's data. The target is
 * printed redacted. Each job's key has to match `retention-switch.service.ts`, and its run action `audit-actions.constant.ts`.
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveDatabaseUrl, redactUrl, scrubSecrets } from "./lib/railway-db-url.mjs";

const require = createRequire(import.meta.url);

const AUDIT_ACTION = "retention.switch.changed";
const REPORT_DAYS = 7;

const JOBS = {
  "demo-bookings": {
    key: "retention.demoBookingsEnforced",
    runAction: "retention.demo-bookings.run",
  },
};

/** The job's run rows since its last one that wasn't in report mode: a run that enforced ends the report period it follows. */
const REPORT_PERIOD_SQL = `
  SELECT coalesce(min("createdAt") <= timezone('UTC', clock_timestamp()) - make_interval(days => $2), false) AS enough
  FROM "AuditLog"
  WHERE action = $1
    AND "createdAt" > coalesce(
      (SELECT max("createdAt") FROM "AuditLog" WHERE action = $1 AND meta->>'mode' IS DISTINCT FROM 'report'),
      '-infinity'::timestamp
    )`;

const USAGE = 'usage: --job <job> --on|--off --reason "<why>" [--apply]';

function parseArgs(argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v && !v.startsWith("--") ? v.trim() : "";
  };
  const on = argv.includes("--on");
  const off = argv.includes("--off");
  return {
    job: value("--job"),
    reason: value("--reason"),
    on,
    valid: on !== off,
    apply: argv.includes("--apply"),
  };
}

function operator() {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || "unknown";
  }
}

function stored(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function main(argv) {
  const { job, reason, on, valid, apply } = parseArgs(argv);
  if (!job || !reason || !valid) {
    console.error(USAGE);
    return 2;
  }
  const target = Object.hasOwn(JOBS, job) ? JOBS[job] : null;
  if (!target) return refuse(`unknown job ${job}`);

  const url = resolveDatabaseUrl(process.env);
  console.log(`Resolved database host: ${redactUrl(url)}`);
  const { Client } = require("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    if (on) {
      const { rows } = await client.query(REPORT_PERIOD_SQL, [target.runAction, REPORT_DAYS]);
      if (!rows[0].enough) {
        return refuse(`${job} has not run in report mode for ${REPORT_DAYS} days`);
      }
    }
    const after = { enforced: on, reason, by: operator(), at: new Date().toISOString() };
    const read = async (lock) => {
      const { rows } = await client.query(
        `SELECT value FROM "PlatformConfig" WHERE key = $1 ${lock}`,
        [target.key],
      );
      return stored(rows[0]?.value);
    };

    if (!apply) {
      const before = await read("");
      console.log(JSON.stringify({ job, key: target.key, before, after, dryRun: true }));
      return 0;
    }

    await client.query("BEGIN");
    try {
      const before = await read("FOR UPDATE");
      await client.query(
        `INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, now())
         ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED.value, "updatedAt" = now()`,
        [target.key, JSON.stringify(after)],
      );
      await client.query(
        `INSERT INTO "AuditLog" (id, action, "entityType", "entityId", meta)
         VALUES ($1, $2, 'RetentionSwitch', $3, $4)`,
        [randomUUID(), AUDIT_ACTION, target.key, JSON.stringify({ job, before, after })],
      );
      await client.query("COMMIT");
      console.log(JSON.stringify({ job, key: target.key, before, after, applied: true }));
    } catch (e) {
      await client.query("ROLLBACK");
      return refuse(`the switch did not move: ${scrubSecrets(e.message, url)}`);
    }
  } finally {
    await client.end();
  }
  return 0;
}

function refuse(why) {
  console.error(`refused: ${why}; nothing written`);
  return 3;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
