// apps/api/scripts/backfill-check-dates.mjs
//
// Post-dated check payments, PR-1 (design doc §10 row 1) — backfills the new, additive-only
// `InvoicePayment.checkDate` column for CHECK payments that are already PAID and still
// genuinely post-dated (their `settledAt` is still in the future relative to when this backfill
// runs). This is the one-time catch-up for rows that predate the `checkDate` column; a later PR
// sets `checkDate` at record time for every new CHECK payment going forward.
//
// NEVER changes `status` — this script only ever writes `checkDate`. `appliedAt` stays null
// (a later PR's UI reads null there as "applied on receipt (legacy)").
//
// Scope (mirrors scripts/lib/check-date-backfill.mjs's `shouldBackfillCheckDate`): every
// InvoicePayment row where method = CHECK, status = PAID, checkStatus NOT IN (CLEARED,
// BOUNCED), checkDate IS NULL (idempotent reruns report 0 changes), and settledAt is strictly
// after `--since <ISO>` (default: this feature's own migration instant,
// 2026-09-15T00:00:00.000Z — L-074/never "now": a rerun months from now must not silently widen
// scope by drifting the cutoff to whenever it happens to run).
//
// Cross-tenant by design (every tenant, not one) — no `assertTestTenant` call here, matching
// `backfill-subscription-reconciliation.mjs`'s own unscoped tenant scan; this is a platform-wide
// data-repair script, not a single-tenant admin action.
//
// Usage:
//   node apps/api/scripts/backfill-check-dates.mjs                  # dry run (default)
//   node apps/api/scripts/backfill-check-dates.mjs --apply          # writes checkDate
//   ... --since <ISO-8601>   # override the cutoff instant (default: the migration's own timestamp)
//   ... --tenant-id <id>     # scope the scan/apply to one tenant — for a db spec or a one-tenant
//   rehearsal (L-129: never let a spec run an unscoped --apply against a shared database).

import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { resolveDatabaseUrl, redactUrl, scrubSecrets } from "./lib/railway-db-url.mjs";
import { planCheckDateBackfill } from "./lib/check-date-backfill.mjs";

// The migration that introduced `checkDate`
// (apps/api/prisma/migrations/20260915000000_check_instrument_fields) — the default cutoff, so
// a rerun without `--since` never silently drifts to "now" (L-074-adjacent: an implicit default
// must stay loud and stable, not resolve to whatever moment the script happens to run).
const MIGRATION_INSTANT = "2026-09-15T00:00:00.000Z";

// Hoisted so the top-level `.catch` below can scrub a connection string out of an error message
// even when the failure happens before or after `main()`'s own try/finally.
let databaseUrl;

/** Parses the optional `--since <ISO-8601>` flag: value required, given at most once, must
 *  parse as a valid date. Defaults to `MIGRATION_INSTANT` (never "now"). */
export function parseSince(argv) {
  const idx = argv.indexOf("--since");
  if (idx === -1) return new Date(MIGRATION_INSTANT);
  if (argv.indexOf("--since", idx + 1) !== -1) {
    throw new Error("--since may be given only once");
  }
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--since requires an ISO-8601 value");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`--since is not a valid date: ${value}`);
  }
  return parsed;
}

/** Parses the optional `--tenant-id <id>` flag: value required, given at most once. Scoping is
 *  purely a query-time filter — it changes nothing about `shouldBackfillCheckDate`'s decision. */
export function parseTenantId(argv) {
  const idx = argv.indexOf("--tenant-id");
  if (idx === -1) return undefined;
  if (argv.indexOf("--tenant-id", idx + 1) !== -1) {
    throw new Error("--tenant-id may be given only once");
  }
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--tenant-id requires a non-empty value");
  }
  return value;
}

async function main() {
  const apply = process.argv.includes("--apply");
  let since;
  let tenantId;
  try {
    since = parseSince(process.argv);
    tenantId = parseTenantId(process.argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  try {
    databaseUrl = resolveDatabaseUrl(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(`Resolved database host: ${redactUrl(databaseUrl)}`);
  console.log(`Cutoff (--since): ${since.toISOString()}`);
  if (tenantId) console.log(`Scoped to tenant: ${tenantId}`);
  const pool = new Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    // Pre-filter as much as Prisma can express (method/status/checkStatus/checkDate); the
    // settledAt-vs-since comparison happens again in `planCheckDateBackfill` so the SAME pure
    // decision logic `backfill-check-dates-script.spec.ts` locks is what decides what actually
    // gets written — this query only bounds the candidate set.
    const candidates = await prisma.invoicePayment.findMany({
      where: {
        method: "CHECK",
        status: "PAID",
        checkStatus: { notIn: ["CLEARED", "BOUNCED"] },
        checkDate: null,
        settledAt: { gt: since },
        ...(tenantId ? { tenantId } : {}),
      },
      select: {
        id: true,
        tenantId: true,
        invoiceId: true,
        settledAt: true,
        status: true,
        method: true,
        checkStatus: true,
        checkDate: true,
      },
    });

    const plan = planCheckDateBackfill(candidates, since);

    console.log(`${candidates.length} candidate row(s) scanned, ${plan.length} change(s):`);
    console.table(
      plan.slice(0, 20).map((r) => ({
        id: r.id,
        invoiceId: r.invoiceId,
        tenantId: r.tenantId,
        settledAt: r.settledAt instanceof Date ? r.settledAt.toISOString() : r.settledAt,
        checkDate: r.checkDate.toISOString().slice(0, 10),
      })),
    );
    if (plan.length > 20) console.log(`...and ${plan.length - 20} more.`);

    if (!apply) {
      console.log("\nDry run only — pass --apply to write these changes.");
      return;
    }

    let applied = 0;
    let failed = 0;
    let raced = 0;
    for (const r of plan) {
      try {
        // Conditional write: re-asserts checkDate IS NULL and method/status/checkStatus still
        // match what was scanned (a concurrent writer may have changed the row between scan and
        // write), and the `data` clause names ONLY `checkDate` — `status` can never be touched
        // by this statement.
        const result = await prisma.invoicePayment.updateMany({
          where: {
            id: r.id,
            method: "CHECK",
            status: "PAID",
            checkStatus: { notIn: ["CLEARED", "BOUNCED"] },
            checkDate: null,
            ...(tenantId ? { tenantId } : {}),
          },
          data: { checkDate: r.checkDate },
        });
        if (result.count === 1) applied++;
        else raced++;
      } catch (err) {
        console.error(`Failed to backfill ${r.id}: ${err.message}`);
        failed++;
      }
    }
    console.log(
      `Applied ${applied} change(s), ${failed} failed, ${raced} raced (rerun to pick up).`,
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// Only run the CLI when this file is the process entry point — never on import (mirrors
// backfill-subscription-reconciliation.mjs's guard).
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    const msg = err?.message ?? String(err);
    // Never print the raw error object — it can embed a connection string (password and all).
    console.error(databaseUrl ? scrubSecrets(msg, databaseUrl) : msg);
    process.exit(1);
  });
}
