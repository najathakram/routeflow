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
 */
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import pg from "pg";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

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

/** Pure: classify one accrual. `payments`: { amount, method, status, createdAt }[]. */
export function classify(row, payments, nsfFees, math, lagMs) {
  const accrued = Number(row.accruedAmount);
  const payable = Number(row.payableAmount);
  if (Math.abs(accrued) <= EPS && Math.abs(payable) <= EPS) return "zeroed";
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
  if (off) return "still_open";
  const newest = Math.max(0, ...payments.map((p) => new Date(p.createdAt).getTime()));
  return new Date(row.updatedAt).getTime() - newest > lagMs ? "healed_after" : "in_sync";
}

function selfTest() {
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
  const cases = [
    ["in_sync", classify(row({}), credit, 0, math, lag)],
    [
      "still_open (booked without the credit)",
      classify(row({ baseAmount: 100, accruedAmount: 10 }), credit, 0, math, lag) === "still_open"
        ? "still_open (booked without the credit)"
        : "x",
    ],
    [
      "healed_after",
      classify(row({ updatedAt: new Date(t0.getTime() + 2 * 3600_000) }), credit, 0, math, lag),
    ],
    ["zeroed", classify(row({ accruedAmount: 0, payableAmount: 0 }), credit, 0, math, lag)],
  ];
  let ok = true;
  for (const [want, got] of cases) {
    const pass = want === got;
    ok &&= pass;
    console.log(`${pass ? "ok  " : "FAIL"} ${want}${pass ? "" : ` (got ${got})`}`);
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
    await client.query("BEGIN READ ONLY");
    const { rows: accruals } = await client.query(
      `SELECT a."invoiceId", a."ratePct", a."baseAmount", a."accruedAmount", a."payableAmount",
              a."updatedAt", i.subtotal, i.discount, i.total
         FROM "CommissionAccrual" a
         JOIN "Invoice" i ON i.id = a."invoiceId"
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

    const counts = { zeroed: 0, still_open: 0, healed_after: 0, in_sync: 0 };
    let openPayableDelta = 0;
    for (const a of accruals) {
      const ps = byInvoice.get(a.invoiceId) ?? [];
      const kind = classify(a, ps, fees.get(a.invoiceId) ?? 0, math, lagMs);
      counts[kind] += 1;
      if (kind === "still_open") {
        const money = {
          subtotal: Number(a.subtotal),
          discount: Number(a.discount),
          total: Number(a.total),
          cashCollected: ps
            .filter((p) => p.status === "PAID" && p.method !== "CREDIT_NOTE")
            .reduce((s, p) => s + Number(p.amount), 0),
          creditApplied: ps
            .filter((p) => p.status === "PAID" && p.method === "CREDIT_NOTE")
            .reduce((s, p) => s + Number(p.amount), 0),
          nsfFees: fees.get(a.invoiceId) ?? 0,
        };
        const target = math.payableCommission(
          math.accruedCommission(math.commissionBase(money), Number(a.ratePct)),
          math.collectionRatio(money),
        );
        openPayableDelta += target - Number(a.payableAmount);
      }
    }
    const report = {
      since: since.toISOString(),
      lagMinutes: lagMs / 60_000,
      accrualsInScope: accruals.length,
      invoicesInScope: ids.length,
      ...counts,
      stillOpenPayableDelta: Math.round(openPayableDelta * 100) / 100,
    };
    if (process.argv.includes("--json")) console.log(JSON.stringify(report));
    else for (const [k, v] of Object.entries(report)) console.log(`${k.padEnd(24)} ${v}`);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
