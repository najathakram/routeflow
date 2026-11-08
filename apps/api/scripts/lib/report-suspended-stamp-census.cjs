/**
 * The pure + SQL part of report-suspended-stamp-census.mjs (CommonJS so a jest spec can require it).
 *
 * Counts non-deleted SUSPENDED tenants, grouped by Tenant.class and readOnlyReason, plus (PRODUCTION only)
 * whether a TenantSubscription row exists. SELECT only; the output is counts only: no tenant id, slug or name
 * is selected at all.
 */
"use strict";

/** Session TimeZone pinned to UTC at connect (the schema's DateTime columns hold UTC). */
const SET_UTC = "SET TimeZone = 'UTC'";

const ADMIN_SET_REASON = "admin_set";
const OVERDUE_SUSPENDED_REASON = "overdue_suspended";
/** Tenant.class values, PRODUCTION first (the one the owner decides on). */
const CLASS_ORDER = ["PRODUCTION", "DEMO", "TEST", "INTERNAL"];

/**
 * Parity copy of `paymentReinstatable("SUSPENDED", reason)` (apps/api/src/billing/dunning-config.ts): a SUSPENDED
 * tenant is lifted by a payment unless an admin stamped it `admin_set`. Re-derived (the script runs as plain
 * node, the source is TypeScript); `report-suspended-stamp-census-script.spec.ts` pins the parity.
 */
function suspendedReinstatable(reason) {
  return (reason ?? null) !== ADMIN_SET_REASON;
}

/** One row per (class, readOnlyReason, has-subscription, has-stripeSubId). No identifying column. */
const CENSUS_SQL = `
  SELECT t."class"::text AS "class",
         t."readOnlyReason" AS "reason",
         (s."id" IS NOT NULL) AS "hasSub",
         (s."stripeSubId" IS NOT NULL) AS "hasStripeSubId",
         count(*)::int AS "n"
    FROM "Tenant" t
    LEFT JOIN "TenantSubscription" s ON s."tenantId" = t."id"
   WHERE t."status" = 'SUSPENDED' AND t."deletedAt" IS NULL
   GROUP BY 1, 2, 3, 4`;

const reasonBucket = (reason) =>
  reason == null
    ? "null"
    : reason === OVERDUE_SUSPENDED_REASON || reason === ADMIN_SET_REASON
      ? reason
      : "other";

function emptyClass(isProduction) {
  const c = {
    suspended: 0,
    byReason: { null: 0, overdue_suspended: 0, admin_set: 0, other: 0 },
    reinstatableNow: 0,
  };
  if (isProduction) c.subscription = { present: 0, withStripeSubId: 0, absent: 0 };
  return c;
}

/** Fold the census rows into the per-class report. Pure. */
function foldCensus(rows) {
  const classes = {};
  for (const c of CLASS_ORDER) classes[c] = emptyClass(c === "PRODUCTION");
  for (const r of rows) {
    const c = (classes[r.class] ??= emptyClass(r.class === "PRODUCTION"));
    c.suspended += r.n;
    c.byReason[reasonBucket(r.reason)] += r.n;
    if (suspendedReinstatable(r.reason)) c.reinstatableNow += r.n;
    if (c.subscription) {
      if (r.hasSub) c.subscription.present += r.n;
      else c.subscription.absent += r.n;
      if (r.hasStripeSubId) c.subscription.withStripeSubId += r.n;
    }
  }
  const totals = { suspended: 0, reinstatableNow: 0 };
  for (const c of Object.values(classes)) {
    totals.suspended += c.suspended;
    totals.reinstatableNow += c.reinstatableNow;
  }
  return { classes, totals };
}

async function buildReport(client) {
  return foldCensus((await client.query(CENSUS_SQL)).rows);
}

const NOTE =
  "No local TenantSubscription column says the Stripe subscription is cancelled and this report does not call " +
  "Stripe: it reports whether a subscription row (and a stripeSubId) is present, nothing more.";

function jsonReport(report, { generatedAt }) {
  return { generatedAt, note: NOTE, ...report };
}

function formatReport(report, { generatedAt }) {
  const L = [
    "=== SUSPENDED TENANTS THAT MISS THE stripe_cancelled STAMP: read-only, counts only ===",
    `generated ${generatedAt} · non-deleted tenants with status SUSPENDED · no tenant id, slug or name is printed`,
    NOTE,
    "",
  ];
  for (const c of CLASS_ORDER) {
    const x = report.classes[c];
    if (!x) continue;
    L.push(`${c}${c === "PRODUCTION" ? "  (the one that matters)" : ""}`);
    L.push(`  suspended                 ${x.suspended}`);
    L.push(
      `  readOnlyReason            NULL ${x.byReason.null} · overdue_suspended ${x.byReason.overdue_suspended} · admin_set ${x.byReason.admin_set} · other ${x.byReason.other}`,
    );
    L.push(`  a payment lifts today     ${x.reinstatableNow}`);
    if (x.subscription)
      L.push(
        `  subscription row          present ${x.subscription.present} (with stripeSubId ${x.subscription.withStripeSubId}) · absent ${x.subscription.absent}`,
      );
  }
  L.push(
    "",
    `TOTAL suspended ${report.totals.suspended} · a payment lifts ${report.totals.reinstatableNow}`,
  );
  L.push(
    "",
    "what the numbers mean",
    "  These tenants were suspended before the Stripe-cancel writer started leaving readOnlyReason='stripe_cancelled',",
    "  and a SUSPENDED tenant never reaches the SUSPENDED->CANCELLED arm that stamps it, so the back-office win-back",
    "  link does not know they churned. NULL / overdue_suspended rows are lifted by a payment already (see 'a payment",
    "  lifts today'); admin_set rows are not and must not be (an admin decision). PRODUCTION with a stripeSubId are the",
    "  backfill candidates; whether that Stripe subscription is actually cancelled needs a separate, owner-run Stripe",
    "  look. Test classes are listed for completeness only.",
  );
  return L.join("\n");
}

const WRITE_FLAGS = ["--apply", "--fix", "--repair"];
function checkArgs(argv) {
  const hit = WRITE_FLAGS.find((f) => argv.includes(f));
  if (hit)
    return {
      ok: false,
      message: `refusing ${hit}: this report is read-only and has no write mode`,
    };
  const hostFlag = argv.filter((a) => a.startsWith("--target-host="));
  if (hostFlag.length > 1) return { ok: false, message: "--target-host given more than once" };
  for (const a of argv) {
    if (a.startsWith("--target-host=") || a === "--json") continue;
    return { ok: false, message: `unexpected argument ${a}` };
  }
  return {
    ok: true,
    json: argv.includes("--json"),
    targetHost: hostFlag.length ? hostFlag[0].slice("--target-host=".length) : null,
  };
}

module.exports = {
  SET_UTC,
  CENSUS_SQL,
  CLASS_ORDER,
  WRITE_FLAGS,
  suspendedReinstatable,
  foldCensus,
  buildReport,
  jsonReport,
  formatReport,
  checkArgs,
};
