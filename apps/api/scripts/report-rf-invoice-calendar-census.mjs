/**
 * READ-ONLY census for SA-744r2 (row 80: manual-pay invoice windows follow the calendar). The owner reads
 * it BEFORE the deploy; nothing here writes. It lists, for the RF invoicing candidates:
 *
 *   A. subscriptions whose periodEnd is not within the inclusive 24 h snap of a B(m) (the 1st at 12:00Z),
 *      with the planned ALIGNMENT window and its exact day fraction (merged into the next month when it
 *      is under 3 days) - these are the invoices the deploy will issue differently;
 *   B. non-VOID RfInvoices with periodEnd > the subscription's periodEnd (issued ahead), or whose start or
 *      end is not within the snap of a B(m) - old-shape invoices, with status, period and amount;
 *   C. the void-and-reissue candidates (M2 deploy ruling): OPEN invoices whose periodStart >= the
 *      subscription's periodEnd (issued ahead). PAID ones and a current-period OPEN one are LEFT as they are;
 *   D. cycle-label mismatches (B863): windows of 300+ days labelled MONTHLY are FLAGGED for the owner (a
 *      365-day row labelled MONTHLY); the roll prices a row as ANNUAL from 360 days (effectiveCycle), so a
 *      300-359 day window is flagged but keeps its label. ANNUAL-labelled rows whose last window is under
 *      300 days are flagged too. A 364-day row is ANNUAL.
 *   E. external rows with NO periodStart (not invoice candidates, but rollCycles still rolls them): the window
 *      the roll will write, by label.
 *   Plan-only estimates: an unaligned MONTHLY row's first prorated amount from basePriceSnapshot (add-ons are
 *   not included; ANNUAL rows get none because the snapshot is monthly).
 *
 * Output: COUNTS by default. `--owner-ids` adds internal ids (tenant / invoice ids, never a slug or a
 * name) for the owner only. `--self-test` runs the pure part with no database.
 *
 *   railway run --service postgres node apps/api/scripts/report-rf-invoice-calendar-census.mjs [--owner-ids]
 *
 * SAFETY: `BEGIN READ ONLY` + statement/lock timeouts before any query; the connection is closed in `finally`.
 * Applying the M2 void/re-issue is NOT done here: it goes through the existing admin void path and
 * issue-now, dry-run first, with an owner yes for each live tenant.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const cal = require("./lib/rf-calendar-windows.cjs");

const SCRIPT = "report-rf-invoice-calendar-census";
const DAY = cal.DAY_MS;
export const READ_ONLY_SESSION = [
  "BEGIN READ ONLY",
  "SET LOCAL statement_timeout = '60s'",
  "SET LOCAL lock_timeout = '5s'",
];

const iso = (d) => d.toISOString();
const windowDays = (a, b) => (b.getTime() - a.getTime()) / DAY;

/** The first invoice's plan-only prorated amount (merged: plus one full month), or null when unknowable. */
function planOnlyEstimate(base, cycle, frac, merged) {
  if (cycle !== "MONTHLY" || base == null || !Number.isFinite(Number(base))) return null;
  const prorated = Math.round(((Number(base) * frac.daysRemaining) / frac.daysInCycle) * 100) / 100;
  return Math.round((prorated + (merged ? Number(base) : 0)) * 100) / 100;
}

/**
 * Pure. `subs`: { tenantId, cycle, periodStart, periodEnd }[]; `invoices`: { id, tenantId, status,
 * periodStart, periodEnd, amount }[] (non-VOID). Returns the four lists (rows carry internal ids only).
 */
export function classifyCensus(subs, invoices, nullStartSubs = []) {
  const out = {
    unaligned: [],
    oldShapeInvoices: [],
    voidReissue: [],
    cycleMismatch: [],
    nullStartRoll: [],
  };
  for (const s of nullStartSubs) {
    const w = cal.nextBillingWindow(s.periodEnd, s.cycle === "ANNUAL" ? "ANNUAL" : "MONTHLY");
    out.nullStartRoll.push({
      tenantId: s.tenantId,
      cycle: s.cycle,
      rollsTo: [iso(w.periodStart), iso(w.periodEnd)],
    });
  }
  const byTenant = new Map(subs.map((s) => [s.tenantId, s]));
  for (const s of subs) {
    const cycle = cal.effectiveCycle(s.cycle, s.periodStart, s.periodEnd);
    if (!cal.isAligned(s.periodEnd)) {
      const next = cal.nextBillingWindow(s.periodEnd, cycle);
      const b1 = cal.nextBoundaryAfter(cal.snapToBoundary(s.periodEnd));
      const frac = cal.alignFraction(next.periodStart, b1);
      out.unaligned.push({
        tenantId: s.tenantId,
        cycle,
        plannedStart: iso(next.periodStart),
        plannedEnd: iso(next.periodEnd),
        alignmentDays: frac.daysRemaining,
        daysInCycle: frac.daysInCycle,
        merged: cycle === "MONTHLY" && next.periodEnd.getTime() !== b1.getTime(),
        planOnlyEstimate: planOnlyEstimate(
          s.basePriceSnapshot,
          cycle,
          frac,
          next.periodEnd.getTime() !== b1.getTime(),
        ),
      });
    }
    const days = windowDays(s.periodStart, s.periodEnd);
    if (s.cycle === "MONTHLY" && days >= 300) {
      out.cycleMismatch.push({ tenantId: s.tenantId, kind: "monthly-label-annual-window", days });
    } else if (s.cycle === "ANNUAL" && days < 300) {
      out.cycleMismatch.push({ tenantId: s.tenantId, kind: "annual-label-short-window", days });
    }
  }
  for (const inv of invoices) {
    const s = byTenant.get(inv.tenantId);
    if (!s) continue;
    const ahead = inv.periodEnd.getTime() > s.periodEnd.getTime();
    const oddShape = !cal.isAligned(inv.periodStart) || !cal.isAligned(inv.periodEnd);
    if (!ahead && !oddShape) continue;
    out.oldShapeInvoices.push({
      invoiceId: inv.id,
      tenantId: inv.tenantId,
      status: inv.status,
      periodStart: iso(inv.periodStart),
      periodEnd: iso(inv.periodEnd),
      amount: Number(inv.amount),
    });
    if (inv.status === "OPEN" && inv.periodStart.getTime() >= s.periodEnd.getTime()) {
      out.voidReissue.push({ invoiceId: inv.id, tenantId: inv.tenantId });
    }
  }
  return out;
}

/** No-DB checks of the pure part (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const D = (s) => new Date(s);
  const sub = (tenantId, cycle, a, b) => ({
    tenantId,
    cycle,
    periodStart: D(a),
    periodEnd: D(b),
  });
  const subs = [
    sub("t-a", "MONTHLY", "2026-10-12T00:00:00Z", "2026-11-22T00:00:00Z"),
    sub("t-b", "MONTHLY", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"),
    sub("t-c", "MONTHLY", "2025-11-01T00:00:00Z", "2026-11-01T00:00:00Z"),
    sub("t-d", "MONTHLY", "2026-10-30T00:00:00Z", "2026-11-29T00:00:00Z"),
  ];
  const inv = (id, tenantId, status, a, b) => ({
    id,
    tenantId,
    status,
    periodStart: D(a),
    periodEnd: D(b),
    amount: 149,
  });
  const invoices = [
    inv("i1", "t-a", "OPEN", "2026-11-22T00:00:00Z", "2026-12-22T00:00:00Z"),
    inv("i2", "t-b", "PAID", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"),
    inv("i3", "t-a", "PAID", "2026-10-12T00:00:00Z", "2026-11-22T00:00:00Z"),
  ];
  const r = classifyCensus(subs, invoices);
  const must = (cond, msg) => {
    if (!cond) throw new Error(`self-test: ${msg}`);
  };
  must(r.unaligned.length === 2, "two unaligned subs (t-a, t-d)");
  const a = r.unaligned.find((u) => u.tenantId === "t-a");
  must(
    a.plannedStart === "2026-11-22T00:00:00.000Z" && a.plannedEnd === "2026-12-01T12:00:00.000Z",
    "t-a planned alignment window",
  );
  must(a.alignmentDays === 9.5 && a.daysInCycle === 30 && a.merged === false, "t-a 9.5/30");
  const d = r.unaligned.find((u) => u.tenantId === "t-d");
  must(d.merged === true && d.plannedEnd === "2027-01-01T12:00:00.000Z", "t-d merged into January");
  must(
    r.cycleMismatch.length === 1 && r.cycleMismatch[0].tenantId === "t-c",
    "t-c: a 365-day MONTHLY label",
  );
  must(
    r.oldShapeInvoices
      .map((i) => i.invoiceId)
      .sort()
      .join() === "i1,i3",
    "old-shape invoices: i1 (ahead), i3 (unaligned); i2 (legacy 00:00Z) is within the snap, so regular",
  );
  must(
    r.voidReissue.length === 1 && r.voidReissue[0].invoiceId === "i1",
    "only the OPEN invoice issued ahead is a void/re-issue candidate",
  );
  // E: a null-periodStart external row rolls onto the calendar by its label
  const e = classifyCensus(
    [],
    [],
    [{ tenantId: "t-n", cycle: "MONTHLY", periodEnd: D("2026-11-22T00:00:00Z") }],
  );
  must(
    e.nullStartRoll.length === 1 &&
      e.nullStartRoll[0].rollsTo.join() === "2026-11-22T00:00:00.000Z,2026-12-01T12:00:00.000Z",
    "E: null-periodStart row rolls to the alignment window by label",
  );
  // plan-only estimate: 99 x 9.5/30 = 31.35 (MONTHLY); merged adds a full month; ANNUAL gets none
  const withBase = classifyCensus(
    [
      {
        ...sub("t-p", "MONTHLY", "2026-10-12T00:00:00Z", "2026-11-22T00:00:00Z"),
        basePriceSnapshot: 99,
      },
      {
        ...sub("t-m", "MONTHLY", "2026-10-30T00:00:00Z", "2026-11-29T00:00:00Z"),
        basePriceSnapshot: 99,
      },
      {
        ...sub("t-y", "ANNUAL", "2025-10-12T00:00:00Z", "2026-10-22T00:00:00Z"),
        basePriceSnapshot: 99,
      },
    ],
    [],
  );
  const est = Object.fromEntries(withBase.unaligned.map((u) => [u.tenantId, u.planOnlyEstimate]));
  must(est["t-p"] === 31.35, "t-p plan-only estimate 31.35");
  must(est["t-m"] === 107.25, "t-m merged: 2.5/30 x 99 + 99 = 107.25");
  must(est["t-y"] === null, "ANNUAL rows get no estimate");
  // a 300-359 day MONTHLY-labelled window is flagged but does not price as ANNUAL
  const flagged = classifyCensus(
    [sub("t-f", "MONTHLY", "2025-12-01T12:00:00Z", "2026-11-01T12:00:00Z")],
    [],
  );
  must(flagged.cycleMismatch.length === 1, "a 335-day MONTHLY row is flagged (300+)");
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const ownerIds = argv.includes("--owner-ids");
  const databaseUrl = resolveReportDbUrl(SCRIPT);
  if (!databaseUrl) process.exit(2);
  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    for (const sql of READ_ONLY_SESSION) await client.query(sql);
    const subs = (
      await client.query(
        `SELECT s."tenantId", s."cycle"::text AS cycle, s."periodStart", s."periodEnd", s."basePriceSnapshot"
           FROM "TenantSubscription" s JOIN "Tenant" t ON t."id" = s."tenantId"
          WHERE s."externalPayment" = true AND s."stripeSubId" IS NULL AND s."planKey" IS NOT NULL
            AND s."cancelAtPeriodEnd" = false AND s."periodStart" IS NOT NULL AND s."periodEnd" IS NOT NULL
            AND t."class" = 'PRODUCTION' AND t."deletedAt" IS NULL AND t."status" = 'ACTIVE'`,
      )
    ).rows;
    const invoices = (
      await client.query(
        `SELECT "id", "tenantId", "status", "periodStart", "periodEnd", "amount"
           FROM "RfInvoice" WHERE "status" <> 'VOID' AND "tenantId" = ANY($1)`,
        [subs.map((s) => s.tenantId)],
      )
    ).rows;
    const nullStart = (
      await client.query(
        `SELECT s."tenantId", s."cycle"::text AS cycle, s."periodEnd"
           FROM "TenantSubscription" s JOIN "Tenant" t ON t."id" = s."tenantId"
          WHERE s."externalPayment" = true AND s."stripeSubId" IS NULL AND s."planKey" IS NOT NULL
            AND s."periodStart" IS NULL AND s."periodEnd" IS NOT NULL
            AND t."class" = 'PRODUCTION' AND t."deletedAt" IS NULL AND t."status" = 'ACTIVE'`,
      )
    ).rows;
    const r = classifyCensus(subs, invoices, nullStart);
    const merged = r.unaligned.filter((u) => u.merged).length;
    console.log(`RF candidates: ${subs.length}`);
    console.log(
      `A. unaligned period ends (planned alignment window differs): ${r.unaligned.length} (merged: ${merged})`,
    );
    console.log(`B. old-shape invoices (ahead / unaligned): ${r.oldShapeInvoices.length}`);
    console.log(`C. OPEN issued ahead - void and re-issue candidates: ${r.voidReissue.length}`);
    console.log(`D. cycle-label mismatches: ${r.cycleMismatch.length}`);
    console.log(`E. external rows with no periodStart (roll by label): ${r.nullStartRoll.length}`);
    if (ownerIds) console.log(JSON.stringify(r, null, 2));
    await client.query("ROLLBACK");
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
      `${SCRIPT}: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${SCRIPT}: ${e.message}`);
    process.exit(1);
  });
}
