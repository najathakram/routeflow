/**
 * report-mrr-ledger-drift.mjs — READ-ONLY forensic report for the Platform Dashboard's
 * self-contradicting MRR card (`mrr: $0.00` / "Reconciled to ledger: $69.00 · differs by $69.00").
 *
 * MrrService.computeOverview() prices `mrr` fresh on every call from live TenantSubscription/
 * TenantAddon rows; `ledgerMrr` sums the append-only BillingEvent.amountDelta column for
 * currently-PRODUCTION-class tenants. The two are supposed to reconcile — this script finds
 * WHICH tenant(s) they disagree on and WHY, so a fix targets the actual cause instead of
 * papering over the symptom. It performs no repair and emits no repair SQL.
 *
 * Three candidate mechanisms were identified by static code review, all of which leave an
 * identical dashboard signature (live mrr < ledgerMrr, difference credited to a tenant that no
 * longer contributes):
 *   A — PlatformAdminService.updateStatus() (the plain Suspend/Reactivate button) flips a
 *       tenant's status with no compensating BillingEvent — the ledger still carries the old
 *       +run-rate forever. Signature: tenant.status != ACTIVE, but its last BillingEvent is an
 *       old positive delta (plan.changed / subscription.resumed) with nothing after it.
 *   B — BillingService.reconcilePriceLedger() (reachable from updateTenantPriceOverride /
 *       updatePlanPrices) mirrors only `planKey != null` from MrrService's four-part paying
 *       filter (also needs status ACTIVE, deletedAt null, class PRODUCTION) — a price edit on a
 *       non-ACTIVE-but-still-PRODUCTION tenant books a ledger delta live `mrr` never sees.
 *       Signature: a "plan.changed" event with payload.source === "platform_pricing_sync" on a
 *       tenant whose current status is not ACTIVE.
 *   D — PlatformAdminService.updateTenantClass() flips a tenant into PRODUCTION and
 *       `ledgerMrr`'s query (scoped by CURRENT class) then retroactively imports that tenant's
 *       entire historical delta stream, with no compensating entry. Signature: a
 *       "tenant.class_changed" event exists in the tenant's history at all.
 *
 * Usage:
 *   railway run --service postgres node apps/api/scripts/report-mrr-ledger-drift.mjs
 *   railway run --service postgres node apps/api/scripts/report-mrr-ledger-drift.mjs --json
 *
 * SAFETY MODEL (copied from report-train4-damage.mjs — this script must never be able to
 * modify a client database)
 *   - `default_transaction_read_only = on` is the FIRST query issued on the session, so the
 *     server itself rejects a write even if one slipped past review.
 *   - `statement_timeout` caps every query.
 *   - Every query below is a SELECT. There is no write-mode flag anywhere in this file.
 *   - No transaction is left open; the connection is closed in `finally`.
 *   - Output carries only ids-as-ordinals, counts, amounts, statuses, types and dates — no
 *     tenant name, slug, email, or free text. Tenants are printed as ordinals (#1..#n), never
 *     as their real id or slug. BillingEvent.payload is passed through a fixed allow-list of
 *     keys (never printed verbatim) so no client free-text field can leak.
 */
import pg from "pg";
import { resolveDatabaseUrl, redactUrl, scrubSecrets } from "./lib/railway-db-url.mjs";

const KNOWN_FLAGS = new Set(["--help", "--json"]);
const argv = process.argv.slice(2);
let jsonMode = false;
let showHelp = false;
for (const arg of argv) {
  if (!KNOWN_FLAGS.has(arg)) {
    console.error(`Unknown flag: ${arg}`);
    process.exit(2);
  }
  if (arg === "--json") jsonMode = true;
  if (arg === "--help") showHelp = true;
}
if (showHelp) {
  console.error(
    [
      "Usage: report-mrr-ledger-drift.mjs [--json] [--help]",
      "",
      "READ-ONLY forensic report: finds which PRODUCTION-class tenant(s) account for the gap",
      "between MrrService's live `mrr` and the append-only `ledgerMrr`, and classifies each",
      "gap as candidate A (updateStatus — no compensating delta), B (reconcilePriceLedger —",
      "missing status/class filter) or D (updateTenantClass — retroactive import), or leaves",
      "it UNCLASSIFIED for manual review. No repair is performed.",
    ].join("\n"),
  );
  process.exit(0);
}

// ─── Payload allow-list — only these keys are ever printed; anything else (free text, tenant
// metadata) is dropped even if present in the raw JSON. ────────────────────────────────────────
const PAYLOAD_ALLOWED_KEYS = new Set([
  "source",
  "reason",
  "platformAdmin",
  "stripeSynced",
  "stripeReason",
  "toPlan",
  "fromPlan",
]);
function safePayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const out = {};
  for (const k of PAYLOAD_ALLOWED_KEYS) {
    if (k in payload) out[k] = payload[k];
  }
  return out;
}

const round = (v) => Math.round(Number(v ?? 0) * 100) / 100;

async function main() {
  const url = resolveDatabaseUrl();
  console.error(`report-mrr-ledger-drift — ${redactUrl(url)} — READ-ONLY session`);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Belt-and-braces: the server itself refuses any write for the rest of this session.
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '30s'");

    const q = (text, params = []) => client.query(text, params);

    // ─── Top-line platform figures — mirrors MrrService.computeOverview() exactly ──────────────
    const ledgerAgg = await q(
      `SELECT COALESCE(SUM(be."amountDelta"), 0) AS total
         FROM "BillingEvent" be
         JOIN "Tenant" t ON t.id = be."tenantId"
        WHERE t.class = 'PRODUCTION'`,
    );
    const momAgg = await q(
      `SELECT COALESCE(SUM(be."amountDelta"), 0) AS total
         FROM "BillingEvent" be
         JOIN "Tenant" t ON t.id = be."tenantId"
        WHERE t.class = 'PRODUCTION' AND be."createdAt" >= now() - interval '30 days'`,
    );
    const ledgerMrr = round(ledgerAgg.rows[0].total);
    const momDelta = round(momAgg.rows[0].total);

    // ─── Per-tenant: ledger sum (all-time) vs live paying contribution ─────────────────────────
    const rows = await q(
      `SELECT
          t.id,
          t.status,
          t.class,
          t."deletedAt" IS NOT NULL AS "isDeleted",
          s."planKey",
          s."basePriceSnapshot",
          s.discount,
          s."stripeSubId" IS NOT NULL AS "hasStripeSub",
          COALESCE(led.total, 0) AS "ledgerSum",
          COALESCE(addons.total, 0) AS "addonMrr"
        FROM "Tenant" t
        LEFT JOIN "TenantSubscription" s ON s."tenantId" = t.id
        LEFT JOIN (
          SELECT "tenantId", SUM("amountDelta") AS total
            FROM "BillingEvent"
           GROUP BY "tenantId"
        ) led ON led."tenantId" = t.id
        LEFT JOIN (
          SELECT "tenantId", SUM("priceSnapshot" * quantity) AS total
            FROM "TenantAddon"
           WHERE active = true
           GROUP BY "tenantId"
        ) addons ON addons."tenantId" = t.id
        WHERE t.class = 'PRODUCTION'`,
    );

    const drifted = [];
    for (const r of rows.rows) {
      const isPaying =
        r.status === "ACTIVE" && !r.isDeleted && r.planKey != null;
      const liveContribution = isPaying
        ? round(
            (r.basePriceSnapshot != null ? Number(r.basePriceSnapshot) : 0) +
              Number(r.addonMrr ?? 0) -
              Number(r.discount ?? 0),
          )
        : 0;
      const ledgerSum = round(r.ledgerSum);
      const drift = round(ledgerSum - liveContribution);
      if (drift !== 0) {
        drifted.push({ ...r, liveContribution, ledgerSum, drift });
      }
    }

    // ─── Classify each drifted tenant from its BillingEvent history ────────────────────────────
    const findings = [];
    for (let i = 0; i < drifted.length; i++) {
      const t = drifted[i];
      const events = await q(
        `SELECT type, payload, "amountDelta", "createdAt"
           FROM "BillingEvent"
          WHERE "tenantId" = $1
          ORDER BY "createdAt" ASC`,
        [t.id],
      );
      const hasClassChanged = events.rows.some((e) => e.type === "tenant.class_changed");
      const pricingSyncWhileNotActive =
        t.status !== "ACTIVE" &&
        events.rows.some(
          (e) => e.type === "plan.changed" && e.payload?.source === "platform_pricing_sync",
        );
      const last = events.rows[events.rows.length - 1] ?? null;
      const lastIsUncompensatedPositive =
        t.status !== "ACTIVE" &&
        last &&
        Number(last.amountDelta ?? 0) > 0 &&
        (last.type === "plan.changed" ||
          last.type === "subscription.resumed" ||
          last.type === "reconciliation.snapshot_backfilled");

      let candidate = "UNCLASSIFIED";
      if (hasClassChanged) candidate = "D (updateTenantClass — retroactive import)";
      else if (pricingSyncWhileNotActive)
        candidate = "B (reconcilePriceLedger — missing status/class filter)";
      else if (lastIsUncompensatedPositive)
        candidate = "A (updateStatus — no compensating delta)";

      findings.push({
        ordinal: `#${i + 1}`,
        status: t.status,
        isDeleted: t.isDeleted,
        planKey: t.planKey,
        hasStripeSub: t.hasStripeSub,
        liveContribution: t.liveContribution,
        ledgerSum: t.ledgerSum,
        drift: t.drift,
        candidate,
        eventCount: events.rows.length,
        lastEvent: last
          ? { type: last.type, amountDelta: Number(last.amountDelta ?? 0), payload: safePayload(last.payload), createdAt: last.createdAt }
          : null,
      });
    }

    const report = { platform: { ledgerMrr, momDelta }, driftedTenantCount: findings.length, findings };

    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`\nPlatform: ledgerMrr=$${ledgerMrr.toFixed(2)}  momDelta(30d)=$${momDelta.toFixed(2)}`);
    console.log(
      momDelta === 0
        ? "  momDelta is $0 — the drift predates the last 30 days (favours candidate A, an old churn)."
        : `  momDelta is nonzero — the drift is RECENT (favours candidate B or D, an admin action within 30 days).`,
    );
    console.log(`\n${findings.length} PRODUCTION tenant(s) with ledger != live contribution:\n`);
    for (const f of findings) {
      console.log(
        `${f.ordinal}  status=${f.status} deleted=${f.isDeleted} planKey=${f.planKey ?? "null"} ` +
          `stripeSub=${f.hasStripeSub} live=$${f.liveContribution.toFixed(2)} ledger=$${f.ledgerSum.toFixed(2)} ` +
          `drift=$${f.drift.toFixed(2)}`,
      );
      console.log(`     candidate: ${f.candidate}`);
      if (f.lastEvent) {
        console.log(
          `     last event: ${f.lastEvent.type} amountDelta=$${f.lastEvent.amountDelta.toFixed(2)} ` +
            `at ${new Date(f.lastEvent.createdAt).toISOString()} payload=${JSON.stringify(f.lastEvent.payload)}`,
        );
      }
      console.log("");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  const url = (() => {
    try {
      return resolveDatabaseUrl();
    } catch {
      return null;
    }
  })();
  console.error(url ? scrubSecrets(String(err?.stack ?? err), url) : String(err?.stack ?? err));
  process.exit(1);
});
