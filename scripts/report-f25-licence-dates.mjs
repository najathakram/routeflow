/**
 * report-f25-licence-dates.mjs — D6 read-only report for campaign batch F25
 * (bug B91's writer half).
 *
 * Before the F25 fix, the mobile-operator licence-renewal form
 * (`apps/mobile/app/(operator)/customers/[id]/licenses.logic.ts`) wrote a
 * `CustomerAuthorization.expiresAt` as a LOCAL `${date}T23:59:59` instant
 * instead of the schema's UTC-midnight storage convention every other
 * calendar-date field (and every other licence-expiry writer) uses. Reading
 * such a row back through `calendarDateFromIso` (UTC-getter based) shows the
 * WRONG day for any viewer whose local write-time offset pushed the instant
 * past the following UTC midnight.
 *
 * This script is READ-ONLY — it writes nothing and requires no `--execute`
 * flag at all. It finds every `CustomerAuthorization` row whose `expiresAt`
 * is not exactly UTC midnight (`00:00:00.000`), groups the count by tenant,
 * prints a handful of sample ids per tenant, and prints that tenant's
 * `TenantConfig.timezone` (context only — the repair recovers a deviant row's
 * intended day from the stored instant's UTC time-of-day alone, never from
 * the tenant zone; see scripts/lib/recover-calendar-day.cjs). It is the
 * discovery step for
 * `scripts/repair-f25-licence-dates.mjs`, which does the writing.
 *
 * Usage:
 *   node scripts/report-f25-licence-dates.mjs [--verbose]
 *   railway run --service postgres node scripts/report-f25-licence-dates.mjs
 */
import pg from "pg";

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");
const SAMPLE_SIZE = 5;

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
      "  railway run --service postgres node scripts/report-f25-licence-dates.mjs",
  );
  process.exit(2);
}

// Candidate rows: every non-null expiresAt. The UTC-midnight check itself runs
// in JS (below) against the raw instant, mirroring recoverCalendarDay's own
// `isUtcMidnight` test — never re-derived as a SQL time-of-day predicate,
// which would need to special-case NULL/invalid values Postgres and JS treat
// differently.
const SCAN_QUERY = `
  SELECT ca.id AS auth_id, ca."tenantId" AS tenant_id, ca."expiresAt" AS expires_at,
         t.slug AS tenant_slug, tc.timezone AS tenant_timezone
  FROM "CustomerAuthorization" ca
  JOIN "Tenant" t ON t.id = ca."tenantId"
  LEFT JOIN "TenantConfig" tc ON tc."tenantId" = ca."tenantId"
  WHERE ca."expiresAt" IS NOT NULL
  ORDER BY t.slug, ca."expiresAt"
`;

function isUtcMidnight(d) {
  return (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  );
}

const client = new pg.Client({ connectionString: url });

async function main() {
  await client.connect();

  const { rows: dbRows } = await client.query("SELECT current_database() AS db");
  console.log(
    `\nF25 licence-date report — database "${dbRows[0].db}" — READ-ONLY\n${"=".repeat(78)}`,
  );

  const { rows } = await client.query(SCAN_QUERY);

  const byTenant = new Map();
  let deviantTotal = 0;
  for (const r of rows) {
    const expiresAt = new Date(r.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || isUtcMidnight(expiresAt)) continue;
    deviantTotal++;
    if (!byTenant.has(r.tenant_id)) {
      byTenant.set(r.tenant_id, {
        tenantId: r.tenant_id,
        slug: r.tenant_slug,
        timezone: r.tenant_timezone ?? "(no TenantConfig row)",
        count: 0,
        sampleIds: [],
      });
    }
    const entry = byTenant.get(r.tenant_id);
    entry.count++;
    if (entry.sampleIds.length < SAMPLE_SIZE) {
      entry.sampleIds.push({ id: r.auth_id, expiresAt: r.expires_at });
    }
  }

  console.log(
    `\nNon-UTC-midnight CustomerAuthorization.expiresAt rows: ${deviantTotal} total across ` +
      `${byTenant.size} tenant(s)\n`,
  );

  if (byTenant.size === 0) {
    console.log("  (nothing found — every expiresAt row is already UTC midnight)");
  } else {
    for (const entry of byTenant.values()) {
      console.log(
        `  tenant "${entry.slug}" (${entry.tenantId})  timezone=${entry.timezone}  ` +
          `deviant rows=${entry.count}`,
      );
      for (const s of entry.sampleIds) {
        console.log(`    ${s.id}  expiresAt=${new Date(s.expiresAt).toISOString()}`);
      }
      if (VERBOSE && entry.count > entry.sampleIds.length) {
        console.log(`    … and ${entry.count - entry.sampleIds.length} more`);
      }
    }
  }

  console.log(
    `\nTo repair: railway run --service postgres node scripts/repair-f25-licence-dates.mjs ` +
      `--tenant <slug>   (dry run by default — see scripts/REPAIR-RUNBOOK.md)\n`,
  );

  await client.end();
}

main().catch(async (e) => {
  console.error(e);
  await client.end().catch(() => {});
  process.exit(1);
});
