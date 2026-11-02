/**
 * READ-ONLY census for SA-1083. Counts only, with no names, slugs or row contents in the output:
 *   tenants           by status, readOnlyReason, class and deleted; closed with no date; expired trials
 *   autoLockSkips     tenants with a `stripe_cancelled` skip claim
 *   driverLocations   rows, oldest, older than 90 days (recordedAt or createdAt, whichever is older), rows with no tenant
 *   demoBookings      rows, older than 12 months, how many of those have a case with a tenant, a case, a calendar event
 *   nullTenantRows    rows with no tenant, per model the purge classes mark DELETE or SCRUB
 *
 *   node apps/api/scripts/census-retention-sa1083.mjs --tenant <test-tenant-slug>   (local/test DB)
 *   railway run --service postgres node apps/api/scripts/census-retention-sa1083.mjs --all   (owner's per-call yes)
 *   ... --all --closed-list   adds the ids of closed tenants with no date, for the owner's list. Ids only.
 *
 * SAFETY: `default_transaction_read_only = on` before any query; statement_timeout; SELECTs only.
 * `--tenant` must pass assertTestTenant. `--all` reads every tenant and prints only totals.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const require = createRequire(import.meta.url);
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const CLOSED = `(t.status = 'CANCELLED' OR (t.status = 'READ_ONLY' AND t."readOnlyReason" IS NOT DISTINCT FROM 'subscription_cancelled'))`;
const SCOPE = `($1::text IS NULL OR t.slug = $1)`;
const LOCATION_AGE = `least(l."recordedAt", l."createdAt")`;

// DELETE and SCRUB models with a nullable tenantId (the class check in rf-specs, SA-1083 A-3).
export const NULL_TENANT_MODELS = [
  "UserPreference",
  "DeviceToken",
  "RefreshToken",
  "AuthHandoffCode",
  "DriverLocation",
  "CustomerTag",
  "CustomerTagAssignment",
  "CustomerComment",
  "ReplenishmentSnooze",
  "StockAlert",
  "ProductMapping",
  "Message",
  "MessageThread",
  "MessageTemplate",
  "NotificationRule",
  "InboundTriage",
  "AiUsageEvent",
  "User",
  "ContactPerson",
  "Driver",
];

export const TENANT_STATES_SQL = `
SELECT t.status, t."readOnlyReason", t.class, (t."deletedAt" IS NOT NULL) AS deleted, count(*)::int AS tenants
FROM "Tenant" t WHERE ${SCOPE}
GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`;

export const TENANT_TOTALS_SQL = `
SELECT
  count(*) FILTER (WHERE ${CLOSED} AND t."closedAt" IS NULL)::int AS "closedWithNoDate",
  count(*) FILTER (WHERE t.status = 'TRIAL' AND t."trialEndsAt" < now())::int AS "expiredTrials",
  count(*) FILTER (WHERE t.status = 'READ_ONLY' AND t."readOnlyReason" = 'trial_expired')::int AS "readOnlyAfterTrial"
FROM "Tenant" t WHERE ${SCOPE}`;

export const SKIPS_SQL = `
SELECT count(DISTINCT b."tenantId")::int AS "tenantsWithStripeCancelledSkip", count(*)::int AS "stripeCancelledSkipRows"
FROM "BillingNotificationLog" b JOIN "Tenant" t ON t.id = b."tenantId"
WHERE b.milestone = 'AUTO_LOCK_PAUSED:stripe_cancelled' AND ${SCOPE}`;

export const LOCATIONS_SQL = `
SELECT
  count(*)::int AS rows,
  min(${LOCATION_AGE}) AS oldest,
  count(*) FILTER (WHERE ${LOCATION_AGE} < now() - interval '90 days')::int AS "olderThan90Days"
FROM "DriverLocation" l JOIN "Tenant" t ON t.id = l."tenantId" WHERE ${SCOPE}`;

export const LOCATIONS_NO_TENANT_SQL = `
SELECT
  count(*)::int AS rows,
  count(*) FILTER (WHERE ${LOCATION_AGE} < now() - interval '90 days')::int AS "olderThan90Days"
FROM "DriverLocation" l WHERE l."tenantId" IS NULL`;

export const DEMO_BOOKINGS_SQL = `
SELECT
  count(*)::int AS rows,
  count(*) FILTER (WHERE d."startsAt" < now() - interval '12 months')::int AS "olderThan12Months",
  count(*) FILTER (WHERE d."startsAt" < now() - interval '12 months' AND c."tenantId" IS NOT NULL)::int AS "olderWithTenant",
  count(*) FILTER (WHERE d."startsAt" < now() - interval '12 months' AND c.id IS NOT NULL AND c."tenantId" IS NULL)::int AS "olderWithCaseNoTenant",
  count(*) FILTER (WHERE d."startsAt" < now() - interval '12 months' AND d."googleEventId" IS NOT NULL)::int AS "olderWithCalendarEvent"
FROM "DemoBooking" d LEFT JOIN "OnboardingCase" c ON c."demoBookingId" = d.id`;

export const CLOSED_LIST_SQL = `
SELECT t.id, t.status, t."readOnlyReason", t.class, (t."deletedAt" IS NOT NULL) AS deleted
FROM "Tenant" t WHERE ${CLOSED} AND t."closedAt" IS NULL AND ${SCOPE} ORDER BY t.id`;

export async function runCensus(client, slug, { closedList = false } = {}) {
  const one = async (sql, params = []) => (await client.query(sql, params)).rows;
  const out = {
    scope: slug ?? "all",
    tenantStates: await one(TENANT_STATES_SQL, [slug]),
    tenantTotals: (await one(TENANT_TOTALS_SQL, [slug]))[0],
    autoLockSkips: (await one(SKIPS_SQL, [slug]))[0],
    driverLocations: (await one(LOCATIONS_SQL, [slug]))[0],
  };
  if (!slug) {
    out.driverLocationsNoTenant = (await one(LOCATIONS_NO_TENANT_SQL))[0];
    out.demoBookings = (await one(DEMO_BOOKINGS_SQL))[0];
    out.nullTenantRows = {};
    for (const model of NULL_TENANT_MODELS) {
      const [row] = await one(`SELECT count(*)::int AS n FROM "${model}" WHERE "tenantId" IS NULL`);
      out.nullTenantRows[model] = row.n;
    }
  }
  if (closedList) out.closedWithNoDateIds = await one(CLOSED_LIST_SQL, [slug]);
  return out;
}

async function main(argv) {
  const all = argv.includes("--all");
  const i = argv.indexOf("--tenant");
  const slug = i >= 0 ? argv[i + 1] : null;
  if (all === (slug != null)) {
    console.error("usage: --tenant <test-tenant-slug> | --all [--closed-list]");
    return 2;
  }
  if (slug) assertTestTenant(slug, "census-retention-sa1083");
  const url = resolveReportDbUrl("census-retention-sa1083");
  if (!url) return 2;
  const { Client } = require("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    const census = await runCensus(client, slug, { closedList: argv.includes("--closed-list") });
    console.log(JSON.stringify(census, null, 2));
  } finally {
    await client.end();
  }
  return 0;
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
