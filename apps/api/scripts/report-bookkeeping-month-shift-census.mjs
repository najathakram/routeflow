/**
 * READ-ONLY census for SA-906 / W-728 (Bookkeeping windows on the tenant's own day). The owner reads it BEFORE the deploy;
 * nothing here writes. Real-instant events (credit notes, external refunds, write-offs) that fall in a DIFFERENT month on the
 * tenant's own calendar than on the UTC one used today will move between months in the P&L and the dashboards. This lists,
 * per tenant and month, how many events and how many dollars move out of and into that month.
 *
 * Output: tenant ids (internal, never a slug or a name) with counts and dollars. A tenant-month with more than $500 moved is
 * marked STOP (the owner reads it before the deploy). `--self-test` runs the pure part with no database.
 *
 *   railway run --service postgres node apps/api/scripts/report-bookkeeping-month-shift-census.mjs [--months 24]
 *
 * SAFETY: `BEGIN READ ONLY` + statement/lock timeouts before any query; the connection is closed in `finally`.
 */
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

export const STOP_DOLLARS = 500;

const monthIn = (instant, zone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(instant);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g("year")}-${g("month")}`;
};
const validZone = (z) => {
  if (typeof z !== "string" || !/^[A-Za-z]/.test(z)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return z;
  } catch {
    return "UTC";
  }
};

/** Pure. events: { tenantId, kind, at: Date, amount: number }[]; zones: Map<tenantId, zone|null>. */
export function monthShifts(events, zones) {
  const rows = new Map();
  const bucket = (tenantId, month) => {
    const k = `${tenantId}|${month}`;
    if (!rows.has(k))
      rows.set(k, { tenantId, month, movedOut: 0, movedIn: 0, outDollars: 0, inDollars: 0 });
    return rows.get(k);
  };
  for (const e of events) {
    const zone = validZone(zones.get(e.tenantId));
    const from = monthIn(e.at, "UTC");
    const to = monthIn(e.at, zone);
    if (from === to) continue;
    const a = bucket(e.tenantId, from);
    a.movedOut += 1;
    a.outDollars = Math.round((a.outDollars + e.amount) * 100) / 100;
    const b = bucket(e.tenantId, to);
    b.movedIn += 1;
    b.inDollars = Math.round((b.inDollars + e.amount) * 100) / 100;
  }
  return [...rows.values()]
    .map((r) => ({ ...r, stop: Math.max(r.outDollars, r.inDollars) > STOP_DOLLARS }))
    .sort((x, y) => x.tenantId.localeCompare(y.tenantId) || x.month.localeCompare(y.month));
}

function selfTest() {
  const assert = (c, m) => {
    if (!c) throw new Error("self-test failed: " + m);
  };
  const zones = new Map([
    ["a", "America/Chicago"],
    ["b", null],
  ]);
  const ev = [
    { tenantId: "a", kind: "credit", at: new Date("2026-11-01T04:30:00Z"), amount: 100 }, // Oct 31 23:30 Chicago
    { tenantId: "a", kind: "credit", at: new Date("2026-10-15T12:00:00Z"), amount: 50 }, // same month
    { tenantId: "b", kind: "credit", at: new Date("2026-11-01T04:30:00Z"), amount: 900 }, // UTC tenant: no shift
  ];
  const r = monthShifts(ev, zones);
  assert(r.length === 2, "only the Chicago edge moves");
  assert(r.find((x) => x.month === "2026-11").movedOut === 1, "out of November");
  assert(r.find((x) => x.month === "2026-10").movedIn === 1, "into October");
  const big = monthShifts(
    [{ tenantId: "a", kind: "wo", at: new Date("2026-11-01T04:30:00Z"), amount: 600 }],
    zones,
  );
  assert(
    big.every((x) => x.stop),
    "over $500 is STOP",
  );
  console.log("self-test ok");
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return selfTest();
  const mi = argv.indexOf("--months");
  const months = mi >= 0 ? Math.max(1, Number(argv[mi + 1]) || 24) : 24;
  const databaseUrl = resolveReportDbUrl(basename(fileURLToPath(import.meta.url), ".mjs"));
  if (!databaseUrl) process.exit(2);
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET lock_timeout = '5s'");
    await client.query("BEGIN READ ONLY");
    let events;
    let zoneRows;
    try {
      const since = `now() - interval '${months} months'`;
      ({ rows: zoneRows } = await client.query(`SELECT "tenantId", timezone FROM "TenantConfig"`));
      const q = (sql) => client.query(sql).then((r) => r.rows);
      const cn =
        await q(`SELECT "tenantId", "createdAt" AS at, amount::float8 AS amount FROM "CreditNote"
            WHERE status <> 'VOID' AND "createdAt" >= ${since}`);
      const rf =
        await q(`SELECT "tenantId", "refundedAt" AS at, "refundAmount"::float8 AS amount FROM "Return"
            WHERE "refundMethod" = 'EXTERNAL_REFUND' AND "refundedAt" >= ${since}`);
      const wo =
        await q(`SELECT "tenantId", "writtenOffAt" AS at, total::float8 AS amount FROM "Invoice"
            WHERE status = 'WRITTEN_OFF' AND "writtenOffAt" >= ${since}`);
      events = [
        ...cn.map((r) => ({ ...r, kind: "credit" })),
        ...rf.map((r) => ({ ...r, kind: "refund", amount: r.amount ?? 0 })),
        ...wo.map((r) => ({ ...r, kind: "writeoff", amount: r.amount ?? 0 })),
      ].filter((e) => e.tenantId && e.at);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
    const rows = monthShifts(events, new Map(zoneRows.map((z) => [z.tenantId, z.timezone])));
    console.log(
      `events scanned: ${events.length}; tenant-months with a shift: ${rows.length}; STOP rows: ${rows.filter((r) => r.stop).length}`,
    );
    for (const r of rows) {
      console.log(
        `${r.stop ? "STOP " : "     "}${r.tenantId} ${r.month} out ${r.movedOut} ($${r.outDollars.toFixed(2)}) in ${r.movedIn} ($${r.inDollars.toFixed(2)})`,
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

if (isMain) await main();
