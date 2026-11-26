/**
 * READ-ONLY count report (Ops W-1449, bug B1461): DRAFT invoices whose regulated ledger no longer
 * matches their lines.
 *
 * WHAT IT COUNTS. Since 2026-11-03 (f8c56e74e5: a partial invoice books its regulated SALE rows at
 * creation) a partial-price follow on an order could rewrite a DRAFT invoice's line subtotal and
 * category tax without re-syncing the ledger (`applyPartialPriceFollow` never called
 * `resyncInvoiceLedger`). Such a draft's regulated ledger net differs from what its current lines
 * would book. This counts DRAFT invoices updated since the cutoff (default 2026-11-03) that hold, on
 * at least one line, a ledger net (SUM of netSales / categoryTax over the line's
 * RegulatedSalesLedger rows, SALE and REVERSAL) different from the line's stored subtotal /
 * categoryTaxAmount (exactly what `toSaleLedgerLines` books). Lines with no ledger rows at all are
 * not counted (a never-booked line is a different class). Output: total drifted invoices, total
 * drifted lines, and a per-business count keyed by an opaque rank (business #1, #2, ...).
 *
 * Counts only. Never prints a slug, name, id or row content.
 *
 * SAFETY: one `BEGIN READ ONLY` transaction (the server refuses any write), statement_timeout
 * capped, rolled back and closed in `finally`. Only SELECT text exists in this file.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The lead runs it once, on the owner's per-command yes:
 *
 *   railway run --service postgres node apps/api/scripts/report-b1461-stale-draft-tax.mjs
 *
 * Options: --since YYYY-MM-DD (default 2026-11-03), --json, --help. Exit 0 on success, 2 on refusal.
 */
import { createRequire } from "module";
import { maskHost, toOpaqueBuckets, formatBuckets } from "./lib/count-report-shared.mjs";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const { Client } = createRequire(import.meta.url)("pg");

const NAME = "report-b1461-stale-draft-tax";

const HELP = [
  `${NAME} (READ ONLY, counts only)`,
  "Counts DRAFT invoices updated since a date (default 2026-11-03, B1461) whose regulated ledger",
  "net (netSales / categoryTax summed per invoice line) differs from the line's stored subtotal /",
  "category tax. Prints a total and a per-business count keyed by an opaque rank. No names, ids or rows.",
  "Needs the database connection in the environment (Railway proxy variables or the usual URL); refuses without it.",
  "Usage: node apps/api/scripts/report-b1461-stale-draft-tax.mjs [--since YYYY-MM-DD] [--json]",
].join("\n");

const args = process.argv.slice(2);
let since = "2026-11-03";
let json = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--help" || a === "-h") {
    console.log(HELP);
    process.exit(0);
  } else if (a === "--json") json = true;
  else if (a === "--since" || a.startsWith("--since=")) {
    since = a === "--since" ? args[++i] : a.slice("--since=".length);
  } else {
    console.error(`${NAME}: unknown argument ${a} (counts only; see --help)`);
    process.exit(2);
  }
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(since ?? "")) {
  console.error(`${NAME}: --since must be YYYY-MM-DD`);
  process.exit(2);
}

// Shared resolver (B768). Its own log line carries the user name, so it is silenced; only the masked host is printed.
const databaseUrl = resolveReportDbUrl(NAME, { log: () => {} });
if (!databaseUrl) {
  console.error(`${NAME}: refusing to run, no database connection is set in the environment`);
  process.exit(2);
}
console.error(`${NAME}: target ${maskHost(databaseUrl)} (READ ONLY)`);

// Ledger rows are summed per invoice line, scoped to the invoice's own business, then compared with
// the line's stored money. Grouped by business so the caller only ever sees counts.
const DRIFT_SQL = `
  SELECT i."tenantId" AS "tenantId",
         COUNT(DISTINCT i.id)::int AS invoices,
         COUNT(*)::int AS lines
    FROM "Invoice" i
    JOIN "InvoiceItem" it ON it."invoiceId" = i.id
    JOIN (
      SELECT l."invoiceItemId" AS item_id,
             l."tenantId" AS tenant_id,
             SUM(l."netSales") AS net,
             SUM(l."categoryTax") AS tax
        FROM "RegulatedSalesLedger" l
       WHERE l."invoiceItemId" IS NOT NULL
       GROUP BY l."invoiceItemId", l."tenantId"
    ) led ON led.item_id = it.id AND led.tenant_id = i."tenantId"
   WHERE i.status = 'DRAFT'
     AND i."updatedAt" >= $1::date
     AND (ABS(led.net - it.subtotal) >= 0.005
          OR ABS(led.tax - it."categoryTaxAmount") >= 0.005)
   GROUP BY i."tenantId"`;

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '45s'");
    const { rows } = await client.query(DRIFT_SQL, [since]);
    await client.query("ROLLBACK");

    const buckets = toOpaqueBuckets(rows.map((r) => ({ tenantId: r.tenantId, n: r.invoices })));
    const invoiceTotal = rows.reduce((n, r) => n + Number(r.invoices), 0);
    const lineTotal = rows.reduce((n, r) => n + Number(r.lines), 0);
    if (json) {
      console.log(
        JSON.stringify({ since, invoices: invoiceTotal, lines: lineTotal, ...buckets }, null, 2),
      );
    } else {
      console.log(`\n=== B1461 stale draft ledger (since ${since}) - READ ONLY, counts only ===`);
      console.log(`  drifted DRAFT invoices: ${invoiceTotal}`);
      console.log(`  drifted lines: ${lineTotal}`);
      console.log(formatBuckets("drifted DRAFT invoices per business", buckets));
    }
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(`${NAME}: failed (${e && e.code ? e.code : "error"}); nothing was written`);
  process.exit(1);
});
