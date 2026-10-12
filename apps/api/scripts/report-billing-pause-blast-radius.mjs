/**
 * READ-ONLY blast-radius report for the dunning pause (SA-733r7 PR-B3, `BILLING_PAUSE_MODE`).
 *
 * The owner reads this right before flipping `BILLING_PAUSE_MODE` from `dark` to `enforced`:
 *
 *   railway run --service postgres node apps/api/scripts/report-billing-pause-blast-radius.mjs
 *   (add --json for machine-readable output)
 *
 * It answers "who would the pause touch the moment the mode flips?":
 *   - ELIGIBLE: tenants the dunning sweep looks at - a Stripe subscription (`stripeSubId`), not manual-pay
 *     (`externalPayment = false`), no held catch-up claim. There is no `couponFull` exemption.
 *   - STAMPED: eligible tenants that already carry an overdue clock (`pastDueInvoiceId`), with the hours since
 *     `pastDueSince`, the reminders already sent (`BillingNotificationLog`), and what `enforced` would do:
 *       - "pause after final notice" - past 168 h: the first `enforced` sweep sends the final notice; the pause
 *         follows 24 h later, at the first sweep at or after 03:00 tenant-local. NOBODY is paused in hour one.
 *       - "countdown" - not yet 168 h.
 *   - ALREADY PAUSED: tenants in READ_ONLY(`payment_overdue`) or with `pausedAt` set (should be 0 before the flip).
 *   - OUT OF SCOPE (listed so nobody is surprised): ACTIVE tenants with no `stripeSubId`, manual-pay tenants, and
 *     tenants whose catch-up claim is held. The sweep never sees them.
 *
 * WHAT THIS REPORT CANNOT SEE (it is SELECT-only and never calls Stripe):
 *   - open invoices Stripe never attempted: the daily discovery sweep (`billing.dunningDiscovery`, 04:00) finds and
 *     stamps them. The report counts the POPULATION discovery will read (Stripe-billed, not manual-pay, no clock,
 *     no catch-up claim) - an upper bound, not the number it will stamp. After a `dark` day, count the
 *     `billing.dunning.discovered` log lines for the real figure.
 *   - subscriptions whose Stripe `pause_collection` is set but local state does not know it (for example a pause set
 *     by hand in the Stripe dashboard). In `off` / `dark` the reconciler and the invoice.paid heal do NOT remove
 *     them; each logs `billing.dunning.would_unpause tenant=<id> sub=<id>` instead. Those log lines are the signal;
 *     review them before flipping to `enforced`, which WILL remove an unknown pause.
 *   - PAUSED tenants whose clocked invoice was voided / marked uncollectible afterwards: they stay paused until admin
 *     activation; each logs `billing.dunning.paused_on_closed_invoice tenant=<id> invoice=<id> status=<status>` once a day.
 *   - ACTIVE tenants that tried a plan change while an invoice was owed: in `dark` each logs
 *     `billing.dunning.would_refuse code=PAYMENT_OVERDUE tenant=<id> entryPoint=<name>`; count those lines.
 *
 * SAFETY (this script must never be able to touch a client database):
 *   - `default_transaction_read_only = on` is set on the session before any other query runs, so the server itself
 *     rejects a write even if one slipped past review.
 *   - `statement_timeout` caps every query.
 *   - Only SELECT statements appear below; the connection is closed in `finally`.
 *   - OUTPUT carries internal tenant ids and counts only: never a slug, a business name or an email (a pinned rule).
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
import { episodeKey, utcTimestampTypes } from "./lib/pause-report-keys.mjs";
const { Client, types: pgTypes } = createRequire(import.meta.url)("pg");

const PAUSE_HOURS = 168; // DUNNING_PAUSE_HOURS in src/billing/dunning-config.ts
const HOUR_MS = 60 * 60 * 1000;

/**
 * Pure. `eligible`: the joined tenant + subscription rows; `logRows`: BillingNotificationLog rows. One row per tenant
 * carrying a clock - the internal tenant id, never a slug or a name. Notices are keyed per EPISODE
 * (`<invoiceId>:<pastDueSince ISO>`, SA r-note 3).
 */
export function buildStampedRows(eligible, logRows, now) {
  const sentFor = (tenantId, invoiceId, since) =>
    logRows
      .filter((l) => l.tenantId === tenantId && l.key === episodeKey(invoiceId, since))
      .map((l) => l.milestone.replace("DUNNING_", "").toLowerCase())
      .sort();
  return eligible
    .filter((r) => r.pastDueInvoiceId)
    .map((r) => {
      const hours = r.pastDueSince ? (now - new Date(r.pastDueSince)) / HOUR_MS : null;
      const paused = r.status === "READ_ONLY" && r.readOnlyReason === "payment_overdue";
      const action = paused
        ? "already paused"
        : r.status !== "ACTIVE"
          ? `status ${r.status}: not paused`
          : hours != null && hours >= PAUSE_HOURS
            ? "pause after final notice (>= 24 h after the flip)"
            : "countdown";
      return {
        tenantId: r.id,
        status: r.status,
        hoursOverdue: hours == null ? "n/a" : Math.floor(hours),
        remindersSent:
          (r.pastDueSince ? sentFor(r.id, r.pastDueInvoiceId, r.pastDueSince) : []).join(",") ||
          "none",
        onFlip: action,
      };
    });
}

/** No-DB checks of the pure part (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const must = (cond, msg) => {
    if (!cond) throw new Error(`self-test: ${msg}`);
  };
  const now = new Date("2026-11-10T12:00:00Z");
  const since = new Date("2026-11-01T00:00:00Z");
  const row = (id, o = {}) => ({
    id,
    status: "ACTIVE",
    readOnlyReason: null,
    pastDueInvoiceId: "in_1",
    pastDueSince: since,
    pausedAt: null,
    ...o,
  });
  const rows = buildStampedRows(
    [
      row("t-a"),
      row("t-b", { pastDueSince: new Date("2026-11-09T00:00:00Z") }),
      row("t-c", { status: "READ_ONLY", readOnlyReason: "payment_overdue" }),
      row("t-d", { pastDueInvoiceId: null, pastDueSince: null }),
    ],
    [
      { tenantId: "t-a", milestone: "DUNNING_D0", key: episodeKey("in_1", since) },
      { tenantId: "t-a", milestone: "DUNNING_D3", key: episodeKey("in_1", since) },
      // another episode's row is history: it must not count for this one
      { tenantId: "t-b", milestone: "DUNNING_D0", key: episodeKey("in_1", since) },
    ],
    now,
  );
  must(rows.length === 3, "only clocked tenants are listed");
  const by = Object.fromEntries(rows.map((r) => [r.tenantId, r]));
  must(by["t-a"].onFlip.startsWith("pause after"), "t-a is past 168 h");
  must(by["t-a"].remindersSent === "d0,d3", "t-a reminders read by the episode key");
  must(by["t-b"].onFlip === "countdown" && by["t-b"].remindersSent === "none", "t-b countdown");
  must(by["t-c"].onFlip === "already paused", "t-c is paused");
  must(episodeKey("in_1", since) === "in_1:2026-11-01T00:00:00.000Z", "the episode key shape");
  const text = JSON.stringify(rows);
  must(!/slug|email|businessName/i.test(text), "rows carry no slug, name or email");
  return "self-test ok";
}

async function run(client, q, json) {
  await client.connect();
  // Hard read-only guarantee + query cap, before anything else runs.
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '45s'");
  await client.query("SET lock_timeout = '5s'");

  const now = new Date();

  const eligible = await q(
    `SELECT t.id, t.status, t."readOnlyReason", s."pastDueInvoiceId", s."pastDueSince", s."pausedAt"
       FROM "TenantSubscription" s
       JOIN "Tenant" t ON t.id = s."tenantId"
      WHERE s."stripeSubId" IS NOT NULL
        AND s."externalPayment" = false
        AND s."catchupState" IS NULL
        AND t."deletedAt" IS NULL
      ORDER BY t.id ASC`,
  );

  const stampedIds = eligible.filter((r) => r.pastDueInvoiceId).map((r) => r.id);
  const logRows = stampedIds.length
    ? await q(
        `SELECT l."tenantId", l.milestone, l.key, l."sentAt"
           FROM "BillingNotificationLog" l
          WHERE l."tenantId" = ANY($1::text[])
            AND l.milestone IN ('DUNNING_D0','DUNNING_D3','DUNNING_D6','DUNNING_FINAL','DUNNING_PAUSED','DUNNING_PAUSED_STILL_OWED')`,
        [stampedIds],
      )
    : [];

  const stamped = buildStampedRows(eligible, logRows, now);

  const alreadyPaused = eligible.filter(
    (r) => r.pausedAt || (r.status === "READ_ONLY" && r.readOnlyReason === "payment_overdue"),
  );

  const outOfScope = await q(
    `SELECT t.id AS "tenantId",
            CASE
              WHEN s."catchupState" IS NOT NULL THEN 'catch-up claim held'
              WHEN s."externalPayment" = true THEN 'manual-pay (externalPayment)'
              ELSE 'no Stripe subscription'
            END AS reason
       FROM "Tenant" t
       JOIN "TenantSubscription" s ON s."tenantId" = t.id
      WHERE t.status = 'ACTIVE' AND t."deletedAt" IS NULL AND t.class = 'PRODUCTION'
        AND (s."stripeSubId" IS NULL OR s."externalPayment" = true OR s."catchupState" IS NOT NULL)
      ORDER BY t.id ASC`,
  );

  // The population the daily discovery sweep will read (it lists each one's open invoices in Stripe; we cannot).
  const [{ n: discoveryPopulation }] = await q(
    `SELECT COUNT(*)::int AS n
       FROM "TenantSubscription" s
       JOIN "Tenant" t ON t.id = s."tenantId"
      WHERE s."stripeSubId" IS NOT NULL
        AND s."externalPayment" = false
        AND s."catchupState" IS NULL
        AND s."pastDueInvoiceId" IS NULL
        AND t."deletedAt" IS NULL`,
  );

  // SA r-note 5 A2: `suspendOverdueTenants` no longer acts on Stripe past_due / unpaid (dunning owns non-payment).
  // This counts the tenants the OLD cron would have examined (ACTIVE, Stripe-billed, period ended over the 3-day grace
  // ago) - an upper bound, because Stripe's own status is not readable from here - and, of those, the ones that already
  // carry failed payments, which are the ones it would actually have suspended. SELECT-only.
  const [{ n: oldSuspendCronCandidates, failed: oldSuspendCronWithFailedPayments }] = await q(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE s."failedPaymentCount" > 0)::int AS failed
       FROM "TenantSubscription" s
       JOIN "Tenant" t ON t.id = s."tenantId"
      WHERE s."stripeSubId" IS NOT NULL
        AND t.status = 'ACTIVE' AND t."deletedAt" IS NULL
        AND s."periodEnd" < now() - interval '3 days'`,
  );

  const wouldPause = stamped.filter((r) => r.onFlip.startsWith("pause after")).length;
  const summary = {
    eligibleTenants: eligible.length,
    stampedTenants: stamped.length,
    pausedNow: alreadyPaused.length,
    wouldReceiveFinalNoticeOnFlip: wouldPause,
    outOfScopeActive: outOfScope.length,
    discoveryPopulation, // an upper bound: the discovery sweep reads Stripe, this report cannot
    oldSuspendCronCandidates, // tenants master's suspend-overdue cron would have examined (upper bound)
    oldSuspendCronWithFailedPayments, // ...of which carry failed payments: the ones it would have suspended
  };

  if (json) {
    console.log(JSON.stringify({ summary, stamped, outOfScope }, null, 2));
    return;
  }

  console.log(`\n=== BILLING PAUSE BLAST RADIUS ===`);
  console.log("    session is READ ONLY; no writes are possible\n");
  console.table(summary);
  if (stamped.length) {
    console.log("\nStamped (overdue clock running):");
    console.table(stamped);
  } else {
    console.log("\nNo tenant carries an overdue clock.");
  }
  if (outOfScope.length) {
    console.log("\nACTIVE tenants the sweep never sees:");
    console.table(outOfScope);
  }
  console.log(
    "\nLIMITS: this report cannot call Stripe. discoveryPopulation is the number of tenants the daily discovery" +
      " sweep will LIST (an upper bound for what it stamps). A Stripe pause_collection set by hand and not known" +
      " locally is invisible here: in off/dark the reconciler logs `billing.dunning.would_unpause`, and in dark the" +
      " plan changes that enforced would refuse log `billing.dunning.would_refuse` - read those log lines before" +
      " flipping to enforced. A PAUSED tenant whose clocked invoice was later voided or marked uncollectible stays" +
      " paused until admin activation (no automatic resume): each logs `billing.dunning.paused_on_closed_invoice" +
      " tenant=<id> invoice=<id> status=<status>` once a day - review those before and after the flip.",
  );
  console.log(
    `\n${wouldPause} tenant(s) would get the final notice on the first enforced sweep and be paused no sooner than 24 h later.\n`,
  );
  console.log("=== END - session was read-only; nothing was modified ===\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  // Fail closed BEFORE any connection is attempted (B768: the redacted target goes to stderr).
  const databaseUrl = resolveReportDbUrl("report-billing-pause-blast-radius");
  if (!databaseUrl) process.exit(2);
  // pastDueSince is TIMESTAMP(3) WITHOUT a zone: read it as UTC (node-postgres would use the machine's zone and shift
  // the notice key and the hours overdue on anything but a UTC host). See scripts/lib/pause-report-keys.mjs.
  const client = new Client({ connectionString: databaseUrl, types: utcTimestampTypes(pgTypes) });
  const q = async (sql, params) => (await client.query(sql, params)).rows;
  try {
    await run(client, q, json);
  } finally {
    await client.end().catch(() => {});
  }
}

export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    let r = p;
    try {
      r = realpathSync(p);
    } catch {
      // keep the path as given
    }
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  if (norm(entry) === norm(self)) return true;
  if (basename(entry).toLowerCase() === basename(self).toLowerCase()) {
    console.error(
      `report-billing-pause-blast-radius: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error("blast-radius report failed:", e.message);
    process.exitCode = 1;
  });
}
