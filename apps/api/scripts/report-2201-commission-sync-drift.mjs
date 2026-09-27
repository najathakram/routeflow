/**
 * READ-ONLY report for #2201 / SA-394: commission accruals the in-transaction sync got wrong.
 *
 * The defect (fixed in #2234): CommissionEngineService decided "is `db` the caller's transaction?"
 * by testing for a missing `$transaction`. Prisma 7's interactive-tx client HAS `$transaction`, so on
 * a real database the test was always false. Every in-tx commission sync (payments, credit applies,
 * voids, …) therefore ran in its OWN transaction on another connection. It computed the accrual
 * WITHOUT the caller's still-uncommitted payment/credit write, and it never rethrew a conflict. The
 * hourly reconciliation cron (commission-reconciliation.service.ts, :30, 25 h lookback) re-syncs
 * every non-draft invoice touched in the last 25 h, so most rows healed within about 90 min. This
 * report counts what healed and what is still open. Prisma 7 landed in c35a12fd2 (2026-03-09),
 * before the commission engine existed, so the default window covers every accrual.
 *
 * AGGREGATE COUNTS ONLY: no tenant, customer, invoice or agent identifiers are printed (two live
 * paying tenants; owner ruling 2026-09-25). NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs:
 *
 *   npm run build -w apps/api     # once: the script imports the engine's own math from apps/api/dist
 *   railway run --service postgres node apps/api/scripts/report-2201-commission-sync-drift.mjs
 *   ... [--since 2026-03-09] [--lag-minutes 10] [--json]
 *   node apps/api/scripts/report-2201-commission-sync-drift.mjs --self-test   (no database)
 *
 * READ ONLY: one `BEGIN READ ONLY` transaction, rolled back at the end. Postgres refuses any write.
 *
 * WHAT IT COUNTS (every accrual on a non-DRAFT, non-VOID invoice with a payment created >= --since)
 *   The target is recomputed from the invoice's CURRENT money state with the engine's own
 *   commission-math (commissionBase / collectionRatio / accruedCommission / payableCommission) at
 *   the row's STORED ratePct. Rate resolution is not re-run: a rate change is not this defect.
 *   - zeroed:          stored accrued = 0 and payable = 0. A row for an agent who is no longer the
 *                      attributed one is zero-targeted by design. Excluded from the others.
 *   - still_open:      stored base/accrued/payable differ from the target by more than a cent.
 *                      Drift the cron has NOT healed (e.g. an invoice untouched for over 25 h since).
 *   - healed_after:    matches now, but the row's updatedAt is more than --lag-minutes after the
 *                      invoice's newest payment. A later sync (the cron, or a later edit) corrected
 *                      it, which is the signature of a write-time sync that missed its caller's write.
 *                      An ESTIMATE: an unrelated later edit also lands here.
 *   - in_sync:         matches now, updated within the lag of the newest payment.
 *   Not covered: an invoice that SHOULD have an accrual and has none (needs rate resolution).
 *
 * TEST vs LIVE (SA-394 f): every aggregate is reported twice: approved test tenants
 * (scripts/lib/test-tenants.cjs `isTestTenant`, decided in memory from the slug) vs everyone
 * else. No id, slug or name is ever printed. A row whose tenant cannot be resolved counts as live.
 *
 * GUARDS: `BEGIN READ ONLY`, then `SET LOCAL statement_timeout = '60s'` and
 * `SET LOCAL lock_timeout = '5s'`, so a slow query or a held lock aborts the report, never
 * waits on production writers.
 */
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import pg from "pg";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

// In memory only: a tenant's slug decides its cohort and is never printed.
const { isTestTenant } = createRequire(import.meta.url)("../../../scripts/lib/test-tenants.cjs");

const SCRIPT = "report-2201-commission-sync-drift";
const DEFAULT_SINCE = "2026-03-09T00:00:00.000Z"; // c35a12fd2, the Prisma 7 upgrade
const EPS = 0.005;

function loadMath() {
  const here = dirname(fileURLToPath(import.meta.url));
  const require = createRequire(import.meta.url);
  try {
    return require(join(here, "..", "dist", "sales-agents", "commission-math.js"));
  } catch (e) {
    throw new Error(
      `${SCRIPT}: cannot load apps/api/dist/sales-agents/commission-math.js. Run ` +
        `\`npm run build -w apps/api\` first (${e.message})`,
    );
  }
}

/**
 * Pure: classify one accrual and the payable it is off by. `payments`: { amount, method, status,
 * createdAt }[]. Returns { kind, payableDelta } (payableDelta is 0 unless kind is still_open).
 */
export function classify(row, payments, nsfFees, math, lagMs) {
  const accrued = Number(row.accruedAmount);
  const payable = Number(row.payableAmount);
  if (Math.abs(accrued) <= EPS && Math.abs(payable) <= EPS) {
    return { kind: "zeroed", payableDelta: 0 };
  }
  const paid = payments.filter((p) => p.status === "PAID");
  const money = {
    subtotal: Number(row.subtotal),
    discount: Number(row.discount),
    total: Number(row.total),
    cashCollected: paid
      .filter((p) => p.method !== "CREDIT_NOTE")
      .reduce((s, p) => s + Number(p.amount), 0),
    creditApplied: paid
      .filter((p) => p.method === "CREDIT_NOTE")
      .reduce((s, p) => s + Number(p.amount), 0),
    nsfFees,
  };
  const base = math.commissionBase(money);
  const targetAccrued = math.accruedCommission(base, Number(row.ratePct));
  const targetPayable = math.payableCommission(targetAccrued, math.collectionRatio(money));
  const off =
    Math.abs(base - Number(row.baseAmount)) > EPS ||
    Math.abs(targetAccrued - accrued) > EPS ||
    Math.abs(targetPayable - payable) > EPS;
  if (off) return { kind: "still_open", payableDelta: targetPayable - payable };
  const newest = Math.max(0, ...payments.map((p) => new Date(p.createdAt).getTime()));
  const kind = new Date(row.updatedAt).getTime() - newest > lagMs ? "healed_after" : "in_sync";
  return { kind, payableDelta: 0 };
}

/** The session guard, in order: a read-only tx whose statements and lock waits are bounded. */
export const READ_ONLY_SESSION = [
  "BEGIN READ ONLY",
  "SET LOCAL statement_timeout = '60s'",
  "SET LOCAL lock_timeout = '5s'",
];

export async function openReadOnly(client) {
  for (const sql of READ_ONLY_SESSION) await client.query(sql);
}

const emptyCohort = () => ({
  accruals: 0,
  invoices: 0,
  zeroed: 0,
  still_open: 0,
  healed_after: 0,
  in_sync: 0,
  stillOpenPayableDelta: 0,
});

/**
 * Pure: the same aggregates for the TEST cohort (`isTest(slug)`) and the LIVE cohort (everyone
 * else, including a row with no resolvable slug). Rows carry `tenantSlug`, `invoiceId` and the
 * money columns; nothing identifying leaves this function.
 */
export function aggregate(rows, paymentsByInvoice, feesByInvoice, math, lagMs, isTest) {
  const out = { test: emptyCohort(), live: emptyCohort() };
  const invoices = { test: new Set(), live: new Set() };
  for (const r of rows) {
    const cohort = r.tenantSlug != null && isTest(r.tenantSlug) ? "test" : "live";
    const { kind, payableDelta } = classify(
      r,
      paymentsByInvoice.get(r.invoiceId) ?? [],
      feesByInvoice.get(r.invoiceId) ?? 0,
      math,
      lagMs,
    );
    out[cohort].accruals += 1;
    out[cohort][kind] += 1;
    out[cohort].stillOpenPayableDelta += payableDelta;
    invoices[cohort].add(r.invoiceId);
  }
  for (const c of ["test", "live"]) {
    out[c].invoices = invoices[c].size;
    out[c].stillOpenPayableDelta = Math.round(out[c].stillOpenPayableDelta * 100) / 100;
  }
  return out;
}

async function selfTest() {
  const math = {
    commissionBase: (s) => Math.max(0, s.subtotal - s.discount - s.nsfFees - s.creditApplied),
    collectionRatio: (s) =>
      s.total - s.creditApplied <= 0 ? 1 : s.cashCollected / (s.total - s.creditApplied),
    accruedCommission: (b, r) => Math.round(b * r) / 100,
    payableCommission: (a, ratio) => Math.round(a * ratio * 100) / 100,
  };
  const t0 = new Date("2026-06-01T10:00:00Z");
  const row = (over) => ({
    subtotal: 100,
    discount: 0,
    total: 100,
    ratePct: 10,
    baseAmount: 60,
    accruedAmount: 6,
    payableAmount: 0,
    updatedAt: t0,
    ...over,
  });
  const credit = [{ amount: 40, method: "CREDIT_NOTE", status: "PAID", createdAt: t0 }];
  const lag = 10 * 60_000;
  const kind = (r) => classify(r, credit, 0, math, lag).kind;
  const later = new Date(t0.getTime() + 2 * 3600_000);

  // Cohorts: a test slug (qa-*), a live slug, and a row with no slug (counts as live).
  const rows = [
    { ...row({}), tenantSlug: "qa-drift-1", invoiceId: "i1" },
    { ...row({ baseAmount: 100, accruedAmount: 10 }), tenantSlug: "acme-live", invoiceId: "i2" },
    { ...row({ updatedAt: later }), tenantSlug: "acme-live", invoiceId: "i3" },
    { ...row({ accruedAmount: 0, payableAmount: 0 }), tenantSlug: null, invoiceId: "i4" },
  ];
  const pays = new Map(rows.map((r) => [r.invoiceId, credit]));
  const agg = aggregate(rows, pays, new Map(), math, lag, isTestTenant);
  const printed = JSON.stringify(agg);

  const issued = [];
  await openReadOnly({ query: async (sql) => issued.push(sql) });

  const cases = [
    [
      "session guard: BEGIN READ ONLY, then statement_timeout 60s, then lock_timeout 5s",
      issued.join(" | "),
      "BEGIN READ ONLY | SET LOCAL statement_timeout = '60s' | SET LOCAL lock_timeout = '5s'",
    ],
    ["in_sync", kind(row({}))],
    ["still_open", kind(row({ baseAmount: 100, accruedAmount: 10 }))],
    ["healed_after", kind(row({ updatedAt: later }))],
    ["zeroed", kind(row({ accruedAmount: 0, payableAmount: 0 }))],
    ["test cohort: 1 accrual, 1 in_sync", `${agg.test.accruals}/${agg.test.in_sync}`, "1/1"],
    [
      "live cohort: 3 accruals (still_open, healed_after, zeroed incl. the no-slug row)",
      `${agg.live.accruals}/${agg.live.still_open}/${agg.live.healed_after}/${agg.live.zeroed}`,
      "3/1/1/1",
    ],
    ["live invoices counted per cohort", `${agg.live.invoices}`, "3"],
    [
      "no slug or invoice id is ever printed",
      /qa-drift|acme-live|"i\d"/.test(printed) ? "leak" : "clean",
      "clean",
    ],
  ];
  let ok = true;
  for (const [name, got, want = name] of cases) {
    const pass = got === want;
    ok &&= pass;
    console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : ` (got ${got})`}`);
  }
  process.exit(ok ? 0 : 1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const since = new Date(arg("--since", DEFAULT_SINCE));
  if (Number.isNaN(since.getTime())) throw new Error(`${SCRIPT}: bad --since`);
  const lagMs = Number(arg("--lag-minutes", "10")) * 60_000;
  const math = loadMath();
  const url = resolveReportDbUrl(SCRIPT);
  if (!url) process.exit(2);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await openReadOnly(client);
    const { rows: accruals } = await client.query(
      `SELECT a."invoiceId", a."ratePct", a."baseAmount", a."accruedAmount", a."payableAmount",
              a."updatedAt", i.subtotal, i.discount, i.total, t.slug AS "tenantSlug"
         FROM "CommissionAccrual" a
         JOIN "Invoice" i ON i.id = a."invoiceId"
         LEFT JOIN "Tenant" t ON t.id = COALESCE(a."tenantId", i."tenantId")
        WHERE i.status NOT IN ('DRAFT', 'VOID')
          AND EXISTS (SELECT 1 FROM "InvoicePayment" p
                       WHERE p."invoiceId" = i.id AND p."createdAt" >= $1)`,
      [since],
    );
    const ids = [...new Set(accruals.map((a) => a.invoiceId))];
    const { rows: payments } = ids.length
      ? await client.query(
          `SELECT "invoiceId", amount, method, status, "createdAt"
             FROM "InvoicePayment" WHERE "invoiceId" = ANY($1)`,
          [ids],
        )
      : { rows: [] };
    const { rows: nsf } = ids.length
      ? await client.query(
          `SELECT "invoiceId", COALESCE(SUM(qty * "unitPrice"), 0) AS fees
             FROM "InvoiceItem"
            WHERE "invoiceId" = ANY($1) AND description LIKE $2 || '%'
            GROUP BY "invoiceId"`,
          [ids, math.NSF_FEE_DESCRIPTION_PREFIX],
        )
      : { rows: [] };
    const byInvoice = new Map();
    for (const p of payments) {
      if (!byInvoice.has(p.invoiceId)) byInvoice.set(p.invoiceId, []);
      byInvoice.get(p.invoiceId).push(p);
    }
    const fees = new Map(nsf.map((r) => [r.invoiceId, Number(r.fees)]));

    const cohorts = aggregate(accruals, byInvoice, fees, math, lagMs, isTestTenant);
    const report = { since: since.toISOString(), lagMinutes: lagMs / 60_000, ...cohorts };
    if (process.argv.includes("--json")) console.log(JSON.stringify(report));
    else {
      console.log(`since ${report.since} · lag ${report.lagMinutes} min`);
      console.log(`${"".padEnd(24)} ${"test".padStart(10)} ${"live".padStart(10)}`);
      for (const k of Object.keys(cohorts.test)) {
        console.log(
          `${k.padEnd(24)} ${String(cohorts.test[k]).padStart(10)} ${String(cohorts.live[k]).padStart(10)}`,
        );
      }
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

// House entry guard: importing this module (e.g. to unit-test classify/aggregate) never connects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
