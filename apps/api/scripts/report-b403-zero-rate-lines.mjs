/**
 * READ-ONLY report (B403, SA-814 §census): taxed order/estimate-derived invoices whose EVERY goods line still carries
 * InvoiceItem.taxRate = 0, per tenant id and per issue month (UTC), COUNTS and the stored tax only.
 *
 * Why: the tobacco report (tobacco.service.ts, tobacco-report.service.ts) and analytics compute tax as Σ subtotal × taxRate
 * from the lines, so an all-zero pre-#725 invoice with a real header tax silently drops out of its reporting period.
 * SA-814: the reports are correct once the B294 backfill has run; this is the "legacy 0-rate rows" census that says
 * which periods are affected and by how much. After the owner-signed B294 apply it must read 0 for every pre-fix period
 * (a post-fix row left here points at a live writer, B1265).
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs it, in two steps (the live-target guard):
 *   railway run --service postgres node apps/api/scripts/report-b403-zero-rate-lines.mjs
 *   railway run --service postgres node apps/api/scripts/report-b403-zero-rate-lines.mjs --target-host=<host it printed> [--json] [--tenant ID]
 *   node apps/api/scripts/report-b403-zero-rate-lines.mjs --self-test   (no database)
 *
 * SAFETY: the 839 report's pattern. Prints the DB host and refuses BEFORE connecting unless --target-host equals it
 * (exit 64 missing, 65 mismatch); the first statement is the read-only session setting, then BEGIN TRANSACTION READ ONLY,
 * aborts unless transaction_read_only is on, ends in ROLLBACK; refuses --apply/--fix/--repair (exit 2); output is tenant
 * ids, protected/test flags, counts and the stored tax total: no slug, name, customer or invoice number.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
import { notNsfSql } from "./backfill-b294-order-line-taxrate.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const g = require("./lib/report-839-regulated-void-residue.cjs");
const { protectedTenantIds, refuseRetiredFlags } = require("./lib/live-target-guard.cjs");
const { loadProtectedSlugs } = require("./lib/protected-slugs.cjs");

const NAME = "report-b403-zero-rate-lines";

/** Per (tenant, issue month): taxed derived invoices, and those whose every non-NSF line is at rate 0. */
export function periodRowsSql() {
  const nsf = notNsfSql(1);
  return {
    sql: `
  WITH inv AS (
    SELECT i.id, i."tenantId", i."taxAmount",
           to_char(i."issueDate" AT TIME ZONE 'UTC', 'YYYY-MM') AS period
      FROM "Invoice" i
     WHERE i.status <> 'VOID' AND i."taxAmount" > 0
       AND (i."orderId" IS NOT NULL OR EXISTS (SELECT 1 FROM "Estimate" e WHERE e."invoiceId" = i.id))
  ), lines AS (
    SELECT "invoiceId", count(*) AS n, count(*) FILTER (WHERE "taxRate" = 0) AS zero
      FROM "InvoiceItem" WHERE ${nsf.sql} GROUP BY "invoiceId"
  )
  SELECT inv."tenantId", inv.period,
         count(*)::int AS taxed_invoices,
         count(*) FILTER (WHERE l.n > 0 AND l.zero = l.n)::int AS all_zero_invoices,
         COALESCE(sum(l.zero) FILTER (WHERE l.n > 0 AND l.zero = l.n), 0)::int AS all_zero_lines,
         COALESCE(sum(inv."taxAmount") FILTER (WHERE l.n > 0 AND l.zero = l.n), 0)::text AS stored_tax_all_zero
    FROM inv JOIN lines l ON l."invoiceId" = inv.id
   GROUP BY inv."tenantId", inv.period
   ORDER BY inv."tenantId", inv.period`,
    params: nsf.params,
  };
}

const ARGS_KNOWN = new Set(["--json", "--tenant", "--self-test"]);
const TENANT_ID_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

export function checkArgs(argv) {
  const hit = g.WRITE_FLAGS.find((f) => argv.includes(f));
  if (hit)
    return {
      ok: false,
      message: `refusing ${hit}: this report is read-only and has no write mode`,
    };
  const hostFlag = argv.filter((a) => a.startsWith("--target-host="));
  if (hostFlag.length > 1) return { ok: false, message: "--target-host given more than once" };
  const tenantAt = argv.indexOf("--tenant");
  for (const [i, a] of argv.entries()) {
    if (a.startsWith("--target-host=")) continue;
    if (a.startsWith("--") ? !ARGS_KNOWN.has(a) : argv[i - 1] !== "--tenant")
      return { ok: false, message: `unexpected argument ${a}` };
  }
  const tenant = tenantAt >= 0 ? argv[tenantAt + 1] : null;
  if (tenantAt >= 0 && (!tenant || !TENANT_ID_SHAPE.test(tenant)))
    return { ok: false, message: "--tenant needs a tenant id" };
  return {
    ok: true,
    json: argv.includes("--json"),
    selfTest: argv.includes("--self-test"),
    tenant,
    targetHost: hostFlag.length ? hostFlag[0].slice("--target-host=".length) : null,
  };
}

/** Pure: raw SQL rows → { tenants: [{ tenantId, flag, periods[], totals }], totals }. Only periods with an all-zero invoice are kept. */
export function foldRows(rows, protectedIds = new Set()) {
  const by = new Map();
  for (const r of rows) {
    if (!(r.all_zero_invoices > 0)) continue;
    const t = by.get(r.tenantId) ?? {
      tenantId: r.tenantId,
      flag: protectedIds.has(r.tenantId) ? "PROTECTED" : "",
      periods: [],
    };
    t.periods.push({
      period: r.period,
      taxedInvoices: r.taxed_invoices,
      allZeroInvoices: r.all_zero_invoices,
      allZeroLines: r.all_zero_lines,
      storedTaxAllZero: String(r.stored_tax_all_zero),
    });
    by.set(r.tenantId, t);
  }
  const tenants = [...by.values()];
  const totals = { allZeroInvoices: 0, allZeroLines: 0, storedTaxCents: 0 };
  for (const t of tenants)
    for (const p of t.periods) {
      totals.allZeroInvoices += p.allZeroInvoices;
      totals.allZeroLines += p.allZeroLines;
      totals.storedTaxCents += Math.round(Number(p.storedTaxAllZero) * 100);
    }
  return { tenants, totals: { ...totals, storedTax: (totals.storedTaxCents / 100).toFixed(2) } };
}

export function formatReport(rep, meta) {
  const out = [`${NAME} · ${meta.scope} · ${meta.generatedAt} · READ ONLY`];
  if (!rep.tenants.length)
    out.push("no taxed invoice has every goods line at rate 0: nothing for the reports to drop");
  for (const t of rep.tenants) {
    out.push(`tenant ${t.tenantId}${t.flag ? ` [${t.flag}]` : ""}`);
    for (const p of t.periods)
      out.push(
        `  ${p.period}: ${p.allZeroInvoices} of ${p.taxedInvoices} taxed invoice(s) all-zero, ${p.allZeroLines} line(s), stored tax ${p.storedTaxAllZero}`,
      );
  }
  out.push(
    `TOTAL: ${rep.totals.allZeroInvoices} invoice(s), ${rep.totals.allZeroLines} line(s), stored tax ${rep.totals.storedTax} that line-based tax reports leave out`,
    "Next: the B294 backfill dry run says which of these are provable; after its owner-signed apply this report must read 0 for pre-fix periods.",
  );
  return out.join("\n");
}

export async function buildReport(client, { protectedIds, onlyTenant } = {}) {
  const q = periodRowsSql();
  const rows = (await client.query(q.sql, q.params)).rows.filter(
    (r) => !onlyTenant || r.tenantId === onlyTenant,
  );
  return foldRows(rows, protectedIds);
}

export async function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`self-test ${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const row = (o) => ({
    tenantId: "t1",
    period: "2026-08",
    taxed_invoices: 4,
    all_zero_invoices: 0,
    all_zero_lines: 0,
    stored_tax_all_zero: "0",
    ...o,
  });
  eq(foldRows([row({})]).tenants, [], "a clean period is not listed");
  const rep = foldRows(
    [
      row({ all_zero_invoices: 2, all_zero_lines: 5, stored_tax_all_zero: "15.50" }),
      row({
        period: "2026-09",
        all_zero_invoices: 1,
        all_zero_lines: 1,
        stored_tax_all_zero: "0.25",
      }),
    ],
    new Set(["t1"]),
  );
  eq(
    [rep.tenants[0].flag, rep.totals],
    [
      "PROTECTED",
      { allZeroInvoices: 3, allZeroLines: 6, storedTaxCents: 1575, storedTax: "15.75" },
    ],
    "fold and totals",
  );
  for (const f of g.WRITE_FLAGS) if (checkArgs([f]).ok) throw new Error(`self-test: ${f} accepted`);
  eq(g.guardTarget(null, { host: "h" }).code, 64, "missing --target-host");
  eq(g.guardTarget("x", { host: "h" }).code, 65, "mismatched --target-host");
  const seen = [];
  const client = {
    query: async (sql) => (
      seen.push(sql),
      sql === g.SHOW_READ_ONLY ? { rows: [{ transaction_read_only: "on" }] } : { rows: [] }
    ),
  };
  await g.withReadOnlyTx(client, () => buildReport(client, { protectedIds: new Set() }));
  eq(
    [seen[0], seen.at(-1)],
    ["SET default_transaction_read_only = on", "ROLLBACK"],
    "read-only wrapper",
  );
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  try {
    refuseRetiredFlags(argv);
  } catch (e) {
    console.error(`${NAME}: ${e.message}`);
    process.exit(2);
  }
  const args = checkArgs(argv);
  if (!args.ok) {
    console.error(`${NAME}: ${args.message}`);
    process.exit(2);
  }
  if (args.selfTest) {
    console.log(await selfTest());
    return;
  }
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);
  const target = g.targetOf(databaseUrl);
  console.error(`${NAME}: DB host ${target.host} · database ${target.database}`);
  const guard = g.guardTarget(args.targetHost, target);
  if (!guard.ok) {
    console.error(`${NAME}: ${guard.message}`);
    process.exit(guard.code);
  }
  let slugs;
  try {
    slugs = loadProtectedSlugs(process.env, databaseUrl);
  } catch (e) {
    console.error(`${NAME}: ${e.message}`);
    process.exit(2);
  }
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const report = await g.withReadOnlyTx(client, async () => {
      const protectedIds = new Set(await protectedTenantIds(client, slugs));
      return buildReport(client, { protectedIds, onlyTenant: args.tenant });
    });
    const meta = {
      generatedAt: new Date().toISOString(),
      scope: args.tenant ? "one tenant" : "all tenants",
    };
    console.log(
      args.json ? JSON.stringify({ ...meta, ...report }, null, 2) : formatReport(report, meta),
    );
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
