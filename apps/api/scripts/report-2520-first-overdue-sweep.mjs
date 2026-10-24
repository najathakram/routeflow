/**
 * READ-ONLY count for #2520: how many invoices the FIRST run of the new hourly overdue sweep
 * (OverdueSweepService, SA-495a/SA-506) would flip SENT / VIEWED → OVERDUE (never PARTIAL), per tenant.
 *
 * The sweep's rule, mirrored here: a TRIAL or ACTIVE tenant's invoice in SENT / VIEWED
 * whose `dueDate` is before the START of that tenant's local today (its TenantConfig.timezone;
 * UTC when unset), i.e. `dueDate < overdueCutoff(now, tz)`, AND a balance is still owed (SA-770: total minus
 * CONFIRMED payments > 0.005, the same predicate as invoices/invoice-balance-sql.ts). Nothing has ever run this sweep in
 * production (markOverdue was never scheduled), so the first run flips the whole backlog at once.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs it:
 *
 *   railway run --service postgres node apps/api/scripts/report-2520-first-overdue-sweep.mjs
 *   ... add --json for machine-readable output, --tenant <tenantId> to scope it.
 *   node apps/api/scripts/report-2520-first-overdue-sweep.mjs --self-test   (no database)
 *
 * WHAT IT PRINTS: per tenant (anonymous labels A, B, …; no slug or name leaves the process), the
 * invoices the first sweep would flip, split by current status (VIEWED matters: the flip replaces
 * it), their open balance (total minus CONFIRMED payments), and how long past due the oldest is.
 * Live and approved-test tenants are reported separately.
 *
 * SAFETY: `default_transaction_read_only = on`, a statement timeout, SELECTs only. It writes
 * nothing and flips nothing.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const NAME = "report-2520-first-overdue-sweep";

/** Mirrors common/calendar-date.ts overdueCutoff: the UTC-midnight stamp of the zone's today. */
export function cutoffFor(now, timeZone) {
  let tz = timeZone || "UTC";
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    parts = now.toISOString().slice(0, 10); // an invalid zone falls back to UTC, as the helper does
  }
  return new Date(`${parts}T00:00:00.000Z`);
}

/** Anonymous per-tenant summary; ids and slugs never leave this function. */
export function summarize(rows) {
  const label = new Map();
  const detail = rows.map((r) => {
    if (!label.has(r.tenantId))
      label.set(
        r.tenantId,
        `tenant ${String.fromCharCode(65 + (label.size % 26))}${label.size >= 26 ? Math.floor(label.size / 26) : ""}`,
      );
    return {
      tenant: label.get(r.tenantId),
      invoices: r.sent + r.viewed,
      sent: r.sent,
      viewed: r.viewed,
      openBalance: Math.round(r.openBalance * 100) / 100,
      oldestDaysPastDue: r.oldestDaysPastDue,
    };
  });
  return {
    tenants: detail.length,
    invoices: detail.reduce((n, d) => n + d.invoices, 0),
    viewed: detail.reduce((n, d) => n + d.viewed, 0),
    openBalance: Math.round(detail.reduce((n, d) => n + d.openBalance, 0) * 100) / 100,
    detail,
  };
}

export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const now = new Date("2026-10-02T04:30:00.000Z"); // 23:30 Oct 1 in Chicago, 13:30 Oct 2 in Tokyo
  eq(cutoffFor(now, "America/Chicago").toISOString(), "2026-10-01T00:00:00.000Z", "chicago");
  eq(cutoffFor(now, "Asia/Tokyo").toISOString(), "2026-10-02T00:00:00.000Z", "tokyo");
  eq(cutoffFor(now, null).toISOString(), "2026-10-02T00:00:00.000Z", "utc");
  eq(cutoffFor(now, "Not/AZone").toISOString(), "2026-10-02T00:00:00.000Z", "bad zone");
  const s = summarize([
    { tenantId: "t", sent: 2, viewed: 1, openBalance: 10.005, oldestDaysPastDue: 40 },
  ]);
  eq([s.tenants, s.invoices, s.viewed], [1, 3, 1], "summary");
  if (JSON.stringify(s).includes('"t"')) throw new Error("summary leaked a tenant id");
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const known = new Set(["--json", "--tenant"]);
  const tenantArg = argv.indexOf("--tenant");
  const onlyTenant = tenantArg >= 0 ? argv[tenantArg + 1] : null;
  for (const [i, a] of argv.entries())
    if (
      (a.startsWith("--") && !known.has(a)) ||
      (!a.startsWith("--") && argv[i - 1] !== "--tenant")
    ) {
      console.error(`${NAME}: unexpected argument ${a}`);
      process.exit(2);
    }
  if (tenantArg >= 0 && !onlyTenant) {
    console.error(`${NAME}: --tenant needs a tenant id`);
    process.exit(2);
  }
  const json = argv.includes("--json");
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET lock_timeout = '5s'");

    const now = new Date();
    const { rows: tenants } = await client.query(
      `SELECT t.id, t.slug, c.timezone
         FROM "Tenant" t LEFT JOIN "TenantConfig" c ON c."tenantId" = t.id
        WHERE t.status IN ('TRIAL', 'ACTIVE') AND ($1::text IS NULL OR t.id = $1::text)
        ORDER BY t.id`,
      [onlyTenant],
    );
    const rows = [];
    for (const t of tenants) {
      const cutoff = cutoffFor(now, t.timezone);
      const { rows: r } = await client.query(
        `SELECT COUNT(*) FILTER (WHERE i.status = 'SENT')::int    AS sent,
                COUNT(*) FILTER (WHERE i.status = 'VIEWED')::int  AS viewed,
                COALESCE(SUM(i.total - COALESCE(p.paid, 0)), 0)::float AS "openBalance",
                COALESCE(MAX(EXTRACT(DAY FROM ($3::timestamptz - i."dueDate"))), 0)::int AS "oldestDaysPastDue"
           FROM "Invoice" i
           LEFT JOIN (SELECT "invoiceId", SUM(amount) AS paid FROM "InvoicePayment"
                       WHERE status = 'PAID' GROUP BY "invoiceId") p ON p."invoiceId" = i.id
          WHERE i."tenantId" = $1 AND i.status IN ('SENT', 'VIEWED')
            AND i."dueDate" < $2
            AND i.total - COALESCE(p.paid, 0) > 0.005`,
        [t.id, cutoff, now],
      );
      const x = r[0];
      if (x.sent + x.viewed > 0) rows.push({ tenantId: t.id, slug: t.slug, ...x });
    }
    const report = {
      at: now.toISOString(),
      live: summarize(rows.filter((r) => !isTestTenant(r.slug))),
      test: summarize(rows.filter((r) => isTestTenant(r.slug))),
    };
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    for (const block of ["live", "test"]) {
      const s = report[block];
      console.log(
        `${block}: the first sweep would flip ${s.invoices} invoice(s) across ${s.tenants} tenant(s) (${s.viewed} currently VIEWED), open balance ${s.openBalance}`,
      );
      for (const d of s.detail)
        console.log(
          `  ${d.tenant}  ${d.invoices} (SENT ${d.sent}, VIEWED ${d.viewed}), open ${d.openBalance}, oldest ${d.oldestDaysPastDue} day(s) past due`,
        );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return norm(entry) === norm(self) || basename(entry) === basename(self);
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(1);
  });
}
