/**
 * READ-ONLY census for SA-962 G5 / SA-1098 A-5 (row 721): non-void invoices whose regulated lines have no SALE row in the sales
 * ledger, by tenant and period. Before row 721's fix a partial invoice (`createPartialFromOrder`) wrote no ledger rows, so a regulated
 * partial cut before it may sit in a month's filing as an under-report. Two queries, run one at a time:
 *   Q1  per tenant (an anonymous number), period (the invoice's issue month), whether the invoice is tied to an order, its status and
 *       whether a filing already covers that date: invoices, lines and units that have no SALE row
 *   Q2  the same in one line: invoices, lines, units, tenants, and how many of those invoices sit in a filed period
 * The output is counts only: the SQL selects no id, name, slug, price or money. Tenants print as a number (1..n, stable inside one run
 * only) and a class (approved test tenant or not); the owner asks for a tenant's name only if a count is above 0.
 *
 *   node apps/api/scripts/census-partial-invoice-unbooked-sa962.mjs                                  (the DATABASE_URL target; local)
 *   railway run --service postgres node apps/api/scripts/census-partial-invoice-unbooked-sa962.mjs   (the owner's per-call yes)
 *   optional: --timeout-s=<1-1800, default 300>  (statement timeout for each query)
 *
 * At 0 nothing follows. Above 0 it goes to the SA, who decides the one owner question; this script never backfills. Its test ("no SALE row
 * on the line's own id") misses a sale left on an old line id by a rebuild (SA-789), so `--booked-check` sorts the same lines first.
 *
 * SA-962 A-1 (rf-specs 8cf53de5cb): `--booked-check` runs the SA's one count INSTEAD of the census, in the same read-only session: the
 * census's own lines, sorted by whether the sale is on the record under an old line id, on another invoice of the order line, or nowhere,
 * with each line's filing tier. One SELECT, run as one query named `booked`; counts and units by month, no ids, names, prices or money:
 *   railway run --service postgres node apps/api/scripts/census-partial-invoice-unbooked-sa962.mjs --booked-check   (the owner's yes, once)
 * SA-962-q721-booked.sql is embedded byte for byte as BOOKED_SQL (sha-256 pinned by the script spec, and run against the SA's fixture by
 * the db spec).
 *
 * SAFETY: the session is read-only before any query (`default_transaction_read_only = on`, confirmed with SHOW, exit 2 otherwise) and
 * each query runs in its own BEGIN READ ONLY ... ROLLBACK; `statement_timeout` is set; SELECTs only. The target (redacted) goes to
 * stderr, the JSON to stdout. NEVER RUN FROM AN IMPLEMENTATION SESSION AGAINST PRODUCTION.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const require = createRequire(import.meta.url);
const NAME = "census-partial-invoice-unbooked-sa962";
export const DEFAULT_TIMEOUT_S = 300;

export const CENSUS_SQL = String.raw`-- SA-962 G5 census (row 721). SELECT only, plain WITH, for a read-only session. No ids, names, slugs, prices or money: counts and units by anonymous tenant number, class and period.
-- Q1 unbooked regulated lines by tenant, period, order link, status and filed period
WITH unbooked AS (
  SELECT
    ii."tenantId" AS tenant_id,
    ii."invoiceId" AS invoice_id,
    ii.qty AS qty,
    i.status::text AS status,
    (i."orderId" IS NOT NULL) AS order_linked,
    to_char(COALESCE(i."issueDate", i."createdAt"), 'YYYY-MM') AS period,
    EXISTS (
      SELECT 1 FROM "RegulatedFiling" f
      WHERE f."tenantId" = ii."tenantId"
        AND f."trackedCategoryId" = ii."trackedCategoryId"
        AND f."periodStart" <= COALESCE(i."issueDate", i."createdAt")
        AND COALESCE(i."issueDate", i."createdAt") < f."periodEnd"
    ) AS period_filed
  FROM "InvoiceItem" ii
  JOIN "Invoice" i ON i.id = ii."invoiceId"
  WHERE ii."trackedCategoryId" IS NOT NULL
    AND ii.qty > 0
    AND i.status::text <> 'VOID'
    AND NOT EXISTS (
      SELECT 1 FROM "RegulatedSalesLedger" l
      WHERE l."invoiceItemId" = ii.id AND l."entryType"::text = 'SALE'
    )
), numbered AS (
  SELECT u.*, dense_rank() OVER (ORDER BY u.tenant_id) AS tenant_no FROM unbooked u
)
SELECT
  n.tenant_no,
  CASE WHEN t.slug ~ '^(test|e2e-routeflow|routeflow-demo|qa-.*|e2e-.*|ux-audit-.*)$' THEN 'approved_test' ELSE 'other' END AS tenant_class,
  n.period,
  n.order_linked,
  n.status,
  n.period_filed,
  count(DISTINCT n.invoice_id) AS invoices,
  count(*) AS lines,
  sum(n.qty) AS units
FROM numbered n
LEFT JOIN "Tenant" t ON t.id = n.tenant_id
GROUP BY n.tenant_no, tenant_class, n.period, n.order_linked, n.status, n.period_filed
ORDER BY n.tenant_no, n.period, n.order_linked, n.status;
-- Q2 the same, in one line
WITH unbooked AS (
  SELECT
    ii."tenantId" AS tenant_id,
    ii."invoiceId" AS invoice_id,
    ii.qty AS qty,
    EXISTS (
      SELECT 1 FROM "RegulatedFiling" f
      WHERE f."tenantId" = ii."tenantId"
        AND f."trackedCategoryId" = ii."trackedCategoryId"
        AND f."periodStart" <= COALESCE(i."issueDate", i."createdAt")
        AND COALESCE(i."issueDate", i."createdAt") < f."periodEnd"
    ) AS period_filed
  FROM "InvoiceItem" ii
  JOIN "Invoice" i ON i.id = ii."invoiceId"
  WHERE ii."trackedCategoryId" IS NOT NULL
    AND ii.qty > 0
    AND i.status::text <> 'VOID'
    AND NOT EXISTS (
      SELECT 1 FROM "RegulatedSalesLedger" l
      WHERE l."invoiceItemId" = ii.id AND l."entryType"::text = 'SALE'
    )
)
SELECT
  count(DISTINCT invoice_id) AS invoices,
  count(*) AS lines,
  coalesce(sum(qty), 0) AS units,
  count(DISTINCT tenant_id) AS tenants,
  count(DISTINCT invoice_id) FILTER (WHERE period_filed) AS invoices_in_filed_period
FROM unbooked;
`;
export const CENSUS_SQL_SHA256 = createHash("sha256").update(CENSUS_SQL).digest("hex");

export const BOOKED_SQL_COMMIT = "8cf53de5cb8638b8e12e2a451f1ef00039a4d246";
export const BOOKED_SQL = String.raw`-- SA-962 A-1 count. SELECT only, plain WITH, for a read-only session. No ids, names, prices or money: counts and units by month.
-- The census of row 721 (sql sha 8315195d...) again, with what its test cannot see: it looks for a SALE row on the line's own id, and a rebuild can replace that id and leave the SALE row on the old one (SA-789).
-- line_class: booked_old_line_id, on the record on this invoice and the net equals the live lines. booked_net_differs, on the record, the net does not equal them. on_other_invoice_net_above_0, booked on another invoice of the order line. on_other_invoice_net_0, booked elsewhere and reversed. no_sale_row, no SALE row for this order line anywhere.
-- filing_tier: the strongest filing row that covers the invoice's date. The census counted any status.
WITH census AS (
  SELECT ii.id, ii."tenantId" AS tenant_id, ii."invoiceId" AS invoice_id, ii."orderItemId" AS order_item_id, ii."trackedCategoryId" AS cat, ii.qty,
         i.status::text AS status, COALESCE(i."issueDate", i."createdAt") AS at
  FROM "InvoiceItem" ii
  JOIN "Invoice" i ON i.id = ii."invoiceId"
  WHERE ii."trackedCategoryId" IS NOT NULL AND ii.qty > 0 AND i.status::text <> 'VOID'
    AND NOT EXISTS (SELECT 1 FROM "RegulatedSalesLedger" l WHERE l."invoiceItemId" = ii.id AND l."entryType"::text = 'SALE')
), read_lines AS (
  SELECT c.*,
         (SELECT COALESCE(sum(x.qty), 0) FROM "InvoiceItem" x
           WHERE x."invoiceId" = c.invoice_id AND x."trackedCategoryId" = c.cat AND x."orderItemId" IS NOT DISTINCT FROM c.order_item_id) AS live_qty,
         EXISTS (SELECT 1 FROM "RegulatedSalesLedger" l
           WHERE l."invoiceId" = c.invoice_id AND l."trackedCategoryId" = c.cat AND l."orderItemId" IS NOT DISTINCT FROM c.order_item_id AND l."entryType"::text = 'SALE') AS has_here,
         (SELECT COALESCE(sum(l.qty), 0) FROM "RegulatedSalesLedger" l
           WHERE l."invoiceId" = c.invoice_id AND l."trackedCategoryId" = c.cat AND l."orderItemId" IS NOT DISTINCT FROM c.order_item_id) AS net_here,
         c.order_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM "RegulatedSalesLedger" l
           WHERE l."orderItemId" = c.order_item_id AND l."invoiceId" IS DISTINCT FROM c.invoice_id AND l."entryType"::text = 'SALE') AS has_elsewhere,
         (SELECT COALESCE(sum(l.qty), 0) FROM "RegulatedSalesLedger" l
           WHERE l."orderItemId" = c.order_item_id AND l."invoiceId" IS DISTINCT FROM c.invoice_id) AS net_elsewhere,
         (SELECT min(CASE WHEN f.status::text = 'LOCKED' THEN 1 WHEN f.status::text = 'GENERATED' AND f."generatedById" IS NOT NULL THEN 2
                          WHEN f.status::text = 'GENERATED' THEN 3 ELSE 4 END)
            FROM "RegulatedFiling" f
           WHERE f."tenantId" = c.tenant_id AND f."trackedCategoryId" = c.cat AND f."periodStart" <= c.at AND c.at < f."periodEnd") AS tier_no,
         (SELECT oi.qty FROM "OrderItem" oi WHERE oi.id = c.order_item_id) AS ordered_qty
  FROM census c
), classed AS (
  SELECT r.*,
         CASE WHEN r.has_here AND r.net_here = r.live_qty THEN 'booked_old_line_id'
              WHEN r.has_here THEN 'booked_net_differs'
              WHEN r.has_elsewhere AND r.net_elsewhere > 0 THEN 'on_other_invoice_net_above_0'
              WHEN r.has_elsewhere THEN 'on_other_invoice_net_0'
              ELSE 'no_sale_row' END AS line_class,
         CASE r.tier_no WHEN 1 THEN 'locked' WHEN 2 THEN 'prepared_by_a_person' WHEN 3 THEN 'prepared_by_the_daily_job' WHEN 4 THEN 'failed_only' ELSE 'none' END AS filing_tier
  FROM read_lines r
)
SELECT COALESCE(to_char(k.at, 'YYYY-MM'), 'all') AS period, COALESCE(k.status, 'all') AS status, k.line_class, COALESCE(k.filing_tier, 'all') AS filing_tier,
       count(DISTINCT k.tenant_id) AS tenants, count(DISTINCT k.invoice_id) AS invoices, count(*) AS lines, sum(k.qty) AS units,
       count(*) FILTER (WHERE k.live_qty < k.ordered_qty) AS lines_billed_under_ordered
FROM classed k
GROUP BY GROUPING SETS ((to_char(k.at, 'YYYY-MM'), k.status, k.line_class, k.filing_tier), (k.line_class))
ORDER BY 3, 1, 2, 4;
`;
export const BOOKED_SQL_SHA256 = createHash("sha256").update(BOOKED_SQL).digest("hex");

export function splitCensusSql(text = CENSUS_SQL) {
  // The booked check is one plain WITH ... SELECT with no `-- Q<n> ` markers: it runs whole, as written.
  if (text === BOOKED_SQL) return [{ name: "booked", sql: text.trim() }];
  const parts = text.split(/^-- (?=Q\d+ )/m).slice(1);
  return parts.map((p) => ({
    name: p.slice(0, p.indexOf(" ")).toLowerCase(),
    sql: `-- ${p}`.trim(),
  }));
}

export function checkArgs(argv) {
  let timeoutS = DEFAULT_TIMEOUT_S;
  let bookedCheck = false;
  for (const a of argv) {
    if (a === "--booked-check") {
      bookedCheck = true;
      continue;
    }
    const m = /^--timeout-s=(\d+)$/.exec(a);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 1800) {
      return {
        ok: false,
        message: `unknown or invalid argument: ${a} (usage: [--booked-check] [--timeout-s=<1-1800>])`,
      };
    }
    timeoutS = Number(m[1]);
  }
  return { ok: true, timeoutS, bookedCheck };
}

export async function runCensus(
  client,
  { timeoutS = DEFAULT_TIMEOUT_S, log = () => {}, bookedCheck = false } = {},
) {
  await client.query("SET default_transaction_read_only = on");
  const [{ transaction_read_only: ro }] = (await client.query("SHOW transaction_read_only")).rows;
  if (ro !== "on") throw Object.assign(new Error("session is not read-only"), { exitCode: 2 });
  await client.query(`SET statement_timeout = '${timeoutS}s'`);
  const out = {
    spec: bookedCheck
      ? { sqlCommit: BOOKED_SQL_COMMIT, sqlSha256: BOOKED_SQL_SHA256 }
      : { sqlSha256: CENSUS_SQL_SHA256 },
    timingMs: {},
  };
  const t0 = Date.now();
  for (const q of splitCensusSql(bookedCheck ? BOOKED_SQL : CENSUS_SQL)) {
    const t = Date.now();
    await client.query("BEGIN READ ONLY");
    try {
      out[q.name] = (await client.query(q.sql)).rows;
    } finally {
      await client.query("ROLLBACK");
    }
    out.timingMs[q.name] = Date.now() - t;
    log(`${NAME}: ${q.name} ${out[q.name].length} rows in ${out.timingMs[q.name]} ms`);
  }
  out.timingMs.total = Date.now() - t0;
  return out;
}

async function main(argv) {
  const args = checkArgs(argv);
  if (!args.ok) {
    console.error(`${NAME}: ${args.message}`);
    return 2;
  }
  const url = resolveReportDbUrl(NAME);
  if (!url) return 2;
  const { Client } = require("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const census = await runCensus(client, {
      timeoutS: args.timeoutS,
      log: console.error,
      bookedCheck: args.bookedCheck,
    });
    console.log(JSON.stringify(census, null, 2));
  } catch (e) {
    console.error(`${NAME}: ${e.message}`);
    return e.exitCode ?? 1;
  } finally {
    await client.end();
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
