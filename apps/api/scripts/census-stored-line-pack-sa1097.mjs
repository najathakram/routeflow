/**
 * READ-ONLY census for SA-1097: stored box-split order lines with NO unitsPerBox snapshot, the pack each was sold in against
 * today's product pack. The SQL is the SA's, taken from rf-specs decisions/sa/SA-1097-census.sql at 1375ac917b (the file is
 * unchanged at 9e5aa8d361, the latest) and embedded byte for byte as CENSUS_SQL: this script adds no filter, no join and no
 * paging to it. Three queries, run one at a time:
 *   Q1  every bucket, by tenant class and order status (lines, orders, tenants, line total)
 *   Q2  live invoices holding an exposed line (by line link, and by order for items with none)
 *   Q3  edits that may already have hit: consecutive revisions, the later an operator edit that lost the split or took another
 *       pack; money and qty moved, the stock rows the same edit wrote, `split_lost`, live invoices
 * The output is counts and totals only: the SQL selects no id, name, slug or row content.
 *
 *   node apps/api/scripts/census-stored-line-pack-sa1097.mjs                                  (the DATABASE_URL target; local)
 *   railway run --service postgres node apps/api/scripts/census-stored-line-pack-sa1097.mjs   (the owner's per-call yes)
 *   optional: --timeout-s=<1-1800, default 300>  (statement timeout for each of the three queries)
 *
 * SAFETY: the session is read-only before any query (`default_transaction_read_only = on`, confirmed with SHOW, exit 2
 * otherwise) and each query runs in its own BEGIN READ ONLY ... ROLLBACK; `statement_timeout` is set; SELECTs only. The target
 * (redacted) goes to stderr, the JSON to stdout. NEVER RUN FROM AN IMPLEMENTATION SESSION AGAINST PRODUCTION.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const require = createRequire(import.meta.url);
const NAME = "census-stored-line-pack-sa1097";
export const SPEC_SQL_COMMIT = "1375ac917b11ea85a13190e487e73f5ef548cf56";
export const DEFAULT_TIMEOUT_S = 300;

export const CENSUS_SQL = String.raw`-- SA-1097 census. SELECT only, counts and totals, no ids or names. Every query is a plain WITH, because a read-only session can't create a view.
-- Q1 Every bucket, by tenant class and order status.
WITH base AS (
  SELECT oi.id, oi."orderId", o."tenantId", o.status AS order_status, t.class AS tenant_class,
         oi.qty, COALESCE(oi.boxes, 0) AS b, COALESCE(oi.pieces, 0) AS pc, oi."unitPrice" AS price, oi.subtotal,
         COALESCE(oi."promoFreeUnits", 0) AS free, COALESCE(p."unitsPerBox", 0) AS live
  FROM "OrderItem" oi
  JOIN "Order" o ON o.id = oi."orderId"
  JOIN "Product" p ON p.id = oi."productId"
  JOIN "Tenant" t ON t.id = o."tenantId"
  WHERE (oi.boxes IS NOT NULL OR oi.pieces IS NOT NULL)
    AND oi."unitsPerBox" IS NULL
    AND COALESCE(btrim(oi."unitLabel"), '') = ''
    AND oi.status <> 'CANCELLED' AND o.status <> 'CANCELLED'
), own AS (
  SELECT *, CASE WHEN b > 0 AND mod(qty - pc, b) = 0 THEN (qty - pc) / b END AS own_pack,
         live > 1 AND abs(subtotal - round(price * (GREATEST(b - free, 0) + pc::numeric / NULLIF(live, 0)), 2)) <= 0.01 AS fits_live,
         abs(subtotal - round(price * GREATEST(qty - free, 0), 2)) <= 0.01 AS fits_none
  FROM base
), lines AS (
  SELECT *, CASE
      WHEN own_pack > 1 AND own_pack = live THEN 'own_equals_live'
      WHEN own_pack > 1 AND live > 1 THEN 'own_differs_live'
      WHEN own_pack > 1 THEN 'own_pack_live_none'
      WHEN own_pack = 1 AND live > 1 THEN 'no_pack_at_sale_live_set'
      WHEN own_pack = 1 THEN 'no_pack_at_sale_live_none'
      WHEN fits_live AND NOT fits_none THEN 'money_fits_live'
      WHEN fits_none AND NOT fits_live AND live > 1 THEN 'money_fits_none_live_set'
      WHEN fits_none AND NOT fits_live THEN 'money_fits_none_live_none'
      ELSE 'would_refuse' END AS bucket
  FROM own
)
SELECT tenant_class, bucket, order_status, count(*)::int AS lines, count(DISTINCT "orderId")::int AS orders,
       count(DISTINCT "tenantId")::int AS tenants, sum(subtotal) AS line_total
FROM lines GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- Q2 Live invoices holding an exposed line. by_line follows InvoiceItem.orderItemId; by_order follows Invoice.orderId, for items with no line link.
WITH base AS (
  SELECT oi.id, oi."orderId", t.class AS tenant_class,
         oi.qty, COALESCE(oi.boxes, 0) AS b, COALESCE(oi.pieces, 0) AS pc, oi."unitPrice" AS price, oi.subtotal,
         COALESCE(oi."promoFreeUnits", 0) AS free, COALESCE(p."unitsPerBox", 0) AS live
  FROM "OrderItem" oi
  JOIN "Order" o ON o.id = oi."orderId"
  JOIN "Product" p ON p.id = oi."productId"
  JOIN "Tenant" t ON t.id = o."tenantId"
  WHERE (oi.boxes IS NOT NULL OR oi.pieces IS NOT NULL)
    AND oi."unitsPerBox" IS NULL
    AND COALESCE(btrim(oi."unitLabel"), '') = ''
    AND oi.status <> 'CANCELLED' AND o.status <> 'CANCELLED'
), own AS (
  SELECT *, CASE WHEN b > 0 AND mod(qty - pc, b) = 0 THEN (qty - pc) / b END AS own_pack,
         live > 1 AND abs(subtotal - round(price * (GREATEST(b - free, 0) + pc::numeric / NULLIF(live, 0)), 2)) <= 0.01 AS fits_live,
         abs(subtotal - round(price * GREATEST(qty - free, 0), 2)) <= 0.01 AS fits_none
  FROM base
), exposed AS (
  SELECT * FROM own
  WHERE (own_pack > 1 AND own_pack <> live)
     OR (own_pack = 1 AND live > 1)
     OR ((own_pack IS NULL OR own_pack < 1) AND ((fits_none AND NOT fits_live AND live > 1) OR fits_live = fits_none))
), by_line AS (
  SELECT DISTINCT e.tenant_class, i.id, i.status, i.total
  FROM exposed e JOIN "InvoiceItem" ii ON ii."orderItemId" = e.id JOIN "Invoice" i ON i.id = ii."invoiceId"
  WHERE i.status <> 'VOID'
), by_order AS (
  SELECT DISTINCT e.tenant_class, i.id, i.status, i.total
  FROM exposed e JOIN "Invoice" i ON i."orderId" = e."orderId"
  WHERE i.status <> 'VOID'
)
SELECT 'by_line' AS via, tenant_class, status AS invoice_status, count(*)::int AS invoices, sum(total) AS invoice_total FROM by_line GROUP BY 2, 3
UNION ALL
SELECT 'by_order', tenant_class, status, count(*)::int, sum(total) FROM by_order GROUP BY 2, 3
ORDER BY 1, 2, 3;

-- Q3 Possibly already hit, from edit history. Consecutive revisions of an order, the later one an operator edit, one line of the product in both,
-- the earlier one a split with no snapshot, money or qty moved, and the later one lost the split or took a pack the earlier one's own split doesn't show.
WITH rev AS (
  SELECT r."orderId", r."revisionNumber" AS n, r."createdAt" AS at, r.source, r.snapshot->'lineItems' AS items,
         lag(r.snapshot->'lineItems') OVER (PARTITION BY r."orderId" ORDER BY r."revisionNumber") AS prev_items
  FROM "OrderRevision" r
  WHERE jsonb_typeof(r.snapshot->'lineItems') = 'array'
), pairs AS (
  SELECT rev."orderId", rev.at, p->>'productId' AS product_id, (p->>'subtotal')::numeric AS before_total, (x->>'subtotal')::numeric AS after_total,
         (p->>'qty')::numeric AS q, COALESCE((p->>'boxes')::int, 0) AS b, COALESCE((p->>'pieces')::int, 0) AS pc,
         (x->>'qty')::numeric AS next_q, (x->>'unitsPerBox')::int AS next_pack, x->>'boxes' AS next_boxes, x->>'pieces' AS next_pieces
  FROM rev
  CROSS JOIN LATERAL jsonb_array_elements(rev.prev_items) p
  CROSS JOIN LATERAL jsonb_array_elements(rev.items) x
  WHERE rev.prev_items IS NOT NULL AND rev.source = 'EDIT'
    AND p->>'productId' = x->>'productId'
    AND (SELECT count(*) FROM jsonb_array_elements(rev.prev_items) e WHERE e->>'productId' = p->>'productId') = 1
    AND (SELECT count(*) FROM jsonb_array_elements(rev.items) e WHERE e->>'productId' = p->>'productId') = 1
    AND (p->>'boxes' IS NOT NULL OR p->>'pieces' IS NOT NULL)
    AND p->>'unitsPerBox' IS NULL
    AND ((p->>'subtotal')::numeric <> (x->>'subtotal')::numeric OR (p->>'qty')::numeric <> (x->>'qty')::numeric)
), hit AS (
  -- Stock: the SALE rows the same edit wrote, matched by order, product and a 30-second window around the revision. No exact sum: the delivered floor nets it.
  SELECT pairs.*, (SELECT sum(m.quantity) FROM "StockMovement" m
                   WHERE m.reference = 'ORDER:' || pairs."orderId" AND m."productId" = pairs.product_id AND m.type = 'SALE'
                     AND m."createdAt" BETWEEN pairs.at - interval '30 seconds' AND pairs.at + interval '30 seconds') AS ledger_qty
  FROM pairs
  WHERE (next_boxes IS NULL AND next_pieces IS NULL)
     OR (next_pack > 1 AND NOT (b > 0 AND mod(q - pc, b) = 0 AND (q - pc) / b = next_pack))
), inv AS (
  SELECT DISTINCT t.class AS tenant_class, i.id, i.total
  FROM hit h JOIN "Invoice" i ON i."orderId" = h."orderId" JOIN "Order" o ON o.id = h."orderId" JOIN "Tenant" t ON t.id = o."tenantId"
  WHERE i.status <> 'VOID'
), agg AS (
  SELECT t.class AS tenant_class, count(*)::int AS line_changes, count(DISTINCT h."orderId")::int AS orders,
         count(DISTINCT o."tenantId")::int AS tenants,
         count(*) FILTER (WHERE h.after_total < h.before_total)::int AS fell,
         COALESCE(sum(h.before_total - h.after_total) FILTER (WHERE h.after_total < h.before_total), 0) AS fell_by,
         count(*) FILTER (WHERE h.after_total > h.before_total)::int AS rose,
         COALESCE(sum(h.after_total - h.before_total) FILTER (WHERE h.after_total > h.before_total), 0) AS rose_by,
         count(*) FILTER (WHERE h.next_q <> h.q)::int AS qty_moved,
         count(*) FILTER (WHERE h.next_q <> h.q AND h.after_total = h.before_total)::int AS qty_moved_money_same,
         COALESCE(sum(h.next_q - h.q) FILTER (WHERE h.next_q > h.q), 0) AS qty_units_up,
         COALESCE(sum(h.q - h.next_q) FILTER (WHERE h.next_q < h.q), 0) AS qty_units_down,
         count(*) FILTER (WHERE COALESCE(h.ledger_qty, 0) <> 0)::int AS edits_with_stock_row,
         COALESCE(sum(-h.ledger_qty) FILTER (WHERE h.ledger_qty < 0), 0) AS stock_units_out,
         COALESCE(sum(h.ledger_qty) FILTER (WHERE h.ledger_qty > 0), 0) AS stock_units_back,
         count(*) FILTER (WHERE h.next_q <> h.q AND COALESCE(h.ledger_qty, 0) = 0)::int AS qty_moved_no_stock_row,
         count(*) FILTER (WHERE h.next_boxes IS NULL AND h.next_pieces IS NULL)::int AS split_lost
  FROM hit h JOIN "Order" o ON o.id = h."orderId" JOIN "Tenant" t ON t.id = o."tenantId"
  GROUP BY 1
)
SELECT a.*, (SELECT count(*)::int FROM inv WHERE inv.tenant_class = a.tenant_class) AS live_invoices
FROM agg a ORDER BY 1;
`;

export const CENSUS_SQL_SHA256 = createHash("sha256").update(CENSUS_SQL).digest("hex");

/** The three queries, split at the SQL's own `-- Q1` / `-- Q2` / `-- Q3` markers; each runs as written. */
export function splitCensusSql(text = CENSUS_SQL) {
  const parts = text.split(/^-- (?=Q\d )/m).slice(1);
  return parts.map((p) => ({
    name: p.slice(0, p.indexOf(" ")).toLowerCase(),
    sql: `-- ${p}`.trim(),
  }));
}

export function checkArgs(argv) {
  let timeoutS = DEFAULT_TIMEOUT_S;
  for (const a of argv) {
    const m = /^--timeout-s=(\d+)$/.exec(a);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 1800) {
      return {
        ok: false,
        message: `unknown or invalid argument: ${a} (usage: [--timeout-s=<1-1800>])`,
      };
    }
    timeoutS = Number(m[1]);
  }
  return { ok: true, timeoutS };
}

export async function runCensus(client, { timeoutS = DEFAULT_TIMEOUT_S, log = () => {} } = {}) {
  await client.query("SET default_transaction_read_only = on");
  const [{ transaction_read_only: ro }] = (await client.query("SHOW transaction_read_only")).rows;
  if (ro !== "on") throw Object.assign(new Error("session is not read-only"), { exitCode: 2 });
  await client.query(`SET statement_timeout = '${timeoutS}s'`);
  const out = { spec: { sqlCommit: SPEC_SQL_COMMIT, sqlSha256: CENSUS_SQL_SHA256 }, timingMs: {} };
  const t0 = Date.now();
  for (const q of splitCensusSql()) {
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
    const census = await runCensus(client, { timeoutS: args.timeoutS, log: console.error });
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
