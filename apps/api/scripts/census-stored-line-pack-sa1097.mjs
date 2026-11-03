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
 *   optional: --timeout-s=<1-1800, default 300>  (statement timeout for each query)
 *
 * SA-1097 A-5 (rf-specs 42d50272b2): `--denominators` runs the SA's second count INSTEAD of the census, in the same read-only session:
 *   Q4  every order line by tenant class: split, snapshot above 1 / 1 / 0 / none, label, free text, no tenant, cancelled; qty and
 *       money against the snapshot; snapshot against live; old-order counts
 *   Q5  split lines by month written (shows the July backfill and any later no-snapshot write)
 *   Q6  revisions by source, and how many are an order's first edit
 *   Q7  revision line entries: which keys they carry, and whether any revision ever recorded the shape, with dates
 *   Q8  Q3's pairs from every source (at-door changes and merges too)
 *   railway run --service postgres node apps/api/scripts/census-stored-line-pack-sa1097.mjs --denominators   (the owner's per-call yes)
 * SA-1097-denominators.sql is embedded byte for byte as DENOMINATORS_SQL (sha-256 pinned by the script spec); counts and dates only.
 *
 * SA-1098 A-3 (rf-specs 29603388, unchanged at f72e1c1678): `--unbilled` runs the SA's one count INSTEAD of the census, in the same
 * read-only session: live order lines with a delivered quantity that no non-void invoice bills, by tenant class (counts and dates only;
 * an upper bound, since an office partial's remainder looks the same). One SELECT, run as one query named `unbilled`:
 *   railway run --service postgres node apps/api/scripts/census-stored-line-pack-sa1097.mjs --unbilled   (the owner's per-call yes)
 * SA-1098-unbilled.sql is embedded byte for byte as UNBILLED_SQL (sha-256 pinned by the script spec, and run against the SA's fixture
 * by the db spec).
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
export const DENOMINATORS_SQL_COMMIT = "6faf86cde43fa28f4499fd1eb749c6bb0eaf2fc3";
export const UNBILLED_SQL_COMMIT = "29603388630276e43374e2368e959ee35d874045";
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

export const DENOMINATORS_SQL = String.raw`-- SA-1097 denominators. SELECT only, counts and dates, no ids or names. Every query is a plain WITH, for a read-only session. LEFT JOINs on purpose: Q1 to Q3 dropped orders with no tenant and lines with no product.
-- Q4 Every order line, by tenant class. Backfill = migration 20260714000000, which wrote the live pack onto split lines. Nothing here reads a pack at sale.
WITH l AS (
  SELECT COALESCE(t.class::text, 'NO_TENANT') AS tenant_class, oi."createdAt" AS at, oi.qty, COALESCE(oi.boxes, 0) AS b, COALESCE(oi.pieces, 0) AS pc,
         oi."unitsPerBox" AS snap, COALESCE(btrim(oi."unitLabel"), '') <> '' AS labelled, oi."productId" IS NULL AS free_text,
         oi."unitPrice" AS price, oi.subtotal, COALESCE(oi."promoFreeUnits", 0) AS free, COALESCE(p."unitsPerBox", 0) AS live,
         (oi.boxes IS NOT NULL OR oi.pieces IS NOT NULL) AS split,
         (oi.status <> 'CANCELLED' AND o.status <> 'CANCELLED') AS alive,
         o."createdAt" < timestamp '2026-07-14' AS old_order,
         EXISTS (SELECT 1 FROM "OrderRevision" r WHERE r."orderId" = o.id) AS revised
  FROM "OrderItem" oi
  JOIN "Order" o ON o.id = oi."orderId"
  LEFT JOIN "Product" p ON p.id = oi."productId"
  LEFT JOIN "Tenant" t ON t.id = o."tenantId"
)
SELECT tenant_class,
       count(*)::int AS lines_all,
       count(*) FILTER (WHERE alive)::int AS lines_alive,
       min(at) AS first_line_at,
       max(at) AS last_line_at,
       count(*) FILTER (WHERE alive AND split)::int AS split_alive,
       count(*) FILTER (WHERE NOT alive AND split)::int AS split_cancelled,
       count(*) FILTER (WHERE alive AND split AND snap > 1)::int AS split_snap_above_1,
       count(*) FILTER (WHERE alive AND split AND snap = 1)::int AS split_snap_1,
       count(*) FILTER (WHERE alive AND split AND snap = 0)::int AS split_snap_0,
       count(*) FILTER (WHERE alive AND split AND snap IS NULL)::int AS split_no_snap,
       count(*) FILTER (WHERE NOT alive AND split AND snap IS NULL)::int AS split_no_snap_cancelled,
       count(*) FILTER (WHERE alive AND split AND snap IS NULL AND labelled)::int AS split_no_snap_labelled,
       count(*) FILTER (WHERE alive AND split AND snap IS NULL AND free_text)::int AS split_no_snap_free_text,
       count(*) FILTER (WHERE alive AND split AND snap IS NULL AND tenant_class = 'NO_TENANT')::int AS split_no_snap_no_tenant,
       count(*) FILTER (WHERE alive AND split AND snap > 1 AND qty = b * snap + pc)::int AS snap_qty_agrees,
       count(*) FILTER (WHERE alive AND split AND snap > 1 AND qty <> b * snap + pc)::int AS snap_qty_differs,
       COALESCE(sum(subtotal) FILTER (WHERE alive AND split AND snap > 1 AND qty <> b * snap + pc), 0) AS snap_qty_differs_total,
       count(*) FILTER (WHERE alive AND split AND snap > 1 AND qty <> b * snap + pc AND NOT labelled)::int AS snap_qty_differs_unlabelled,
       count(*) FILTER (WHERE alive AND split AND snap > 1 AND abs(subtotal - round(price * (GREATEST(b - free, 0) + pc::numeric / snap), 2)) > 0.01)::int AS snap_money_differs,
       count(*) FILTER (WHERE alive AND split AND snap > 1 AND snap = live)::int AS snap_equals_live,
       count(*) FILTER (WHERE alive AND split AND snap > 1 AND live > 1 AND snap <> live)::int AS snap_differs_live,
       count(*) FILTER (WHERE alive AND split AND snap > 1 AND live <= 1)::int AS snap_live_none,
       count(*) FILTER (WHERE alive AND labelled)::int AS labelled_alive,
       count(*) FILTER (WHERE alive AND NOT split AND snap > 1)::int AS plain_snap_above_1,
       count(*) FILTER (WHERE alive AND old_order)::int AS alive_on_old_order,
       count(*) FILTER (WHERE alive AND old_order AND split)::int AS split_on_old_order,
       count(*) FILTER (WHERE alive AND old_order AND split AND snap > 1 AND qty <> b * snap + pc)::int AS old_order_snap_qty_differs,
       count(*) FILTER (WHERE alive AND old_order AND revised)::int AS alive_old_order_revised
FROM l GROUP BY 1 ORDER BY 1;

-- Q5 Split lines by the month the line was written, by tenant class.
SELECT COALESCE(t.class::text, 'NO_TENANT') AS tenant_class, to_char(oi."createdAt", 'YYYY-MM') AS month,
       count(*)::int AS lines,
       count(*) FILTER (WHERE oi.boxes IS NOT NULL OR oi.pieces IS NOT NULL)::int AS split,
       count(*) FILTER (WHERE (oi.boxes IS NOT NULL OR oi.pieces IS NOT NULL) AND oi."unitsPerBox" > 1)::int AS split_snap_above_1,
       count(*) FILTER (WHERE (oi.boxes IS NOT NULL OR oi.pieces IS NOT NULL) AND oi."unitsPerBox" IS NULL)::int AS split_no_snap
FROM "OrderItem" oi
JOIN "Order" o ON o.id = oi."orderId"
LEFT JOIN "Tenant" t ON t.id = o."tenantId"
GROUP BY 1, 2 ORDER BY 1, 2;

-- Q6 Revisions by tenant class and source. first_of_order = no earlier state, so Q3 could not see that edit.
WITH r AS (
  SELECT COALESCE(t.class::text, 'NO_TENANT') AS tenant_class, r.source, r."orderId", r."createdAt" AS at,
         jsonb_typeof(r.snapshot->'lineItems') = 'array' AS has_lines,
         r."revisionNumber" = min(r."revisionNumber") OVER (PARTITION BY r."orderId") AS first_of_order
  FROM "OrderRevision" r
  JOIN "Order" o ON o.id = r."orderId"
  LEFT JOIN "Tenant" t ON t.id = o."tenantId"
)
SELECT tenant_class, source, count(*)::int AS revisions, count(DISTINCT "orderId")::int AS orders,
       count(*) FILTER (WHERE has_lines)::int AS with_line_list,
       count(*) FILTER (WHERE first_of_order)::int AS first_of_order,
       min(at) AS first_at, max(at) AS last_at
FROM r GROUP BY 1, 2 ORDER BY 1, 2;

-- Q7 Line entries inside revisions: which keys they carry, and whether any revision ever recorded a split with no snapshot.
WITH e AS (
  SELECT COALESCE(t.class::text, 'NO_TENANT') AS tenant_class, r.source, r."orderId", r."createdAt" AS at, x AS item
  FROM "OrderRevision" r
  JOIN "Order" o ON o.id = r."orderId"
  LEFT JOIN "Tenant" t ON t.id = o."tenantId"
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.snapshot->'lineItems') = 'array' THEN r.snapshot->'lineItems' ELSE '[]'::jsonb END) x
)
SELECT tenant_class, source, count(*)::int AS entries,
       count(*) FILTER (WHERE jsonb_exists(item, 'boxes'))::int AS has_boxes_key,
       count(*) FILTER (WHERE jsonb_exists(item, 'pieces'))::int AS has_pieces_key,
       count(*) FILTER (WHERE jsonb_exists(item, 'unitsPerBox'))::int AS has_pack_key,
       count(*) FILTER (WHERE jsonb_exists(item, 'subtotal'))::int AS has_subtotal_key,
       count(*) FILTER (WHERE item->>'boxes' IS NOT NULL OR item->>'pieces' IS NOT NULL)::int AS split_entries,
       count(*) FILTER (WHERE (item->>'boxes' IS NOT NULL OR item->>'pieces' IS NOT NULL) AND item->>'unitsPerBox' IS NULL)::int AS split_no_snap_entries,
       count(DISTINCT "orderId") FILTER (WHERE (item->>'boxes' IS NOT NULL OR item->>'pieces' IS NOT NULL) AND item->>'unitsPerBox' IS NULL)::int AS orders_with_shape,
       min(at) FILTER (WHERE (item->>'boxes' IS NOT NULL OR item->>'pieces' IS NOT NULL) AND item->>'unitsPerBox' IS NULL) AS shape_first_at,
       max(at) FILTER (WHERE (item->>'boxes' IS NOT NULL OR item->>'pieces' IS NOT NULL) AND item->>'unitsPerBox' IS NULL) AS shape_last_at
FROM e GROUP BY 1, 2 ORDER BY 1, 2;

-- Q8 Q3's pairs from every source, not only operator edits: at-door changes and merges read the same pack. Earlier state a split with no snapshot. moved = money or qty changed. hit = Q3's test.
WITH rev AS (
  SELECT r."orderId", r."revisionNumber" AS n, r.source, r.snapshot->'lineItems' AS items,
         lag(r.snapshot->'lineItems') OVER (PARTITION BY r."orderId" ORDER BY r."revisionNumber") AS prev_items
  FROM "OrderRevision" r
  WHERE jsonb_typeof(r.snapshot->'lineItems') = 'array'
), pairs AS (
  SELECT rev."orderId", rev.source, (p->>'subtotal')::numeric AS before_total, (x->>'subtotal')::numeric AS after_total,
         (p->>'qty')::numeric AS q, COALESCE((p->>'boxes')::int, 0) AS b, COALESCE((p->>'pieces')::int, 0) AS pc,
         (x->>'qty')::numeric AS next_q, (x->>'unitsPerBox')::int AS next_pack, x->>'boxes' AS next_boxes, x->>'pieces' AS next_pieces
  FROM rev
  CROSS JOIN LATERAL jsonb_array_elements(rev.prev_items) p
  CROSS JOIN LATERAL jsonb_array_elements(rev.items) x
  WHERE rev.prev_items IS NOT NULL
    AND p->>'productId' = x->>'productId'
    AND (SELECT count(*) FROM jsonb_array_elements(rev.prev_items) e WHERE e->>'productId' = p->>'productId') = 1
    AND (SELECT count(*) FROM jsonb_array_elements(rev.items) e WHERE e->>'productId' = p->>'productId') = 1
    AND (p->>'boxes' IS NOT NULL OR p->>'pieces' IS NOT NULL)
    AND p->>'unitsPerBox' IS NULL
)
SELECT COALESCE(t.class::text, 'NO_TENANT') AS tenant_class, pairs.source, count(*)::int AS pairs, count(DISTINCT pairs."orderId")::int AS orders,
       count(*) FILTER (WHERE before_total <> after_total OR q <> next_q)::int AS moved,
       count(*) FILTER (WHERE (before_total <> after_total OR q <> next_q)
                          AND ((next_boxes IS NULL AND next_pieces IS NULL)
                               OR (next_pack > 1 AND NOT (b > 0 AND mod(q - pc, b) = 0 AND (q - pc) / b = next_pack))))::int AS hit,
       COALESCE(sum(before_total - after_total) FILTER (WHERE after_total < before_total), 0) AS fell_by
FROM pairs
JOIN "Order" o ON o.id = pairs."orderId"
LEFT JOIN "Tenant" t ON t.id = o."tenantId"
GROUP BY 1, 2 ORDER BY 1, 2;
`;

export const DENOMINATORS_SQL_SHA256 = createHash("sha256").update(DENOMINATORS_SQL).digest("hex");

export const UNBILLED_SQL = String.raw`-- SA-1098 A-3 count. SELECT only, plain WITH, for a read-only session. No ids, names, prices or line totals: counts by tenant class.
-- Live order lines with a delivered quantity that no non-void invoice bills. A line delivered at 0 leaves its draft; if it is delivered later the draft can't see it (SA-1098 A-3). An office partial's remainder looks the same, so this is an upper bound. No rows means none.
WITH billed AS (
  SELECT DISTINCT it."orderItemId" AS id
  FROM "InvoiceItem" it
  JOIN "Invoice" i ON i.id = it."invoiceId"
  WHERE i.status <> 'VOID' AND it."orderItemId" IS NOT NULL
), inv AS (
  SELECT i."orderId",
         count(*) FILTER (WHERE i.status = 'DRAFT' AND i."deliveryBatchId" IS NULL)::int AS open_drafts,
         count(*) FILTER (WHERE NOT (i.status = 'DRAFT' AND i."deliveryBatchId" IS NULL))::int AS finalized,
         count(*) FILTER (WHERE i.status = 'DRAFT' AND i."deliveryBatchId" IS NULL AND NOT EXISTS (SELECT 1 FROM "InvoiceItem" x WHERE x."invoiceId" = i.id))::int AS empty_drafts,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "InvoiceItem" x WHERE x."invoiceId" = i.id AND x."orderItemId" IS NULL))::int AS untracked
  FROM "Invoice" i
  WHERE i.status <> 'VOID' AND i."orderId" IS NOT NULL
  GROUP BY 1
)
SELECT COALESCE(t.class::text, 'NO_TENANT') AS tenant_class,
       count(*)::int AS lines,
       count(DISTINCT oi."orderId")::int AS orders,
       count(*) FILTER (WHERE o.status = 'DELIVERED')::int AS on_delivered_order,
       count(*) FILTER (WHERE COALESCE(inv.open_drafts, 0) > 0 AND COALESCE(inv.finalized, 0) = 0)::int AS open_draft_only,
       count(*) FILTER (WHERE COALESCE(inv.empty_drafts, 0) > 0)::int AS on_order_with_empty_draft,
       count(*) FILTER (WHERE COALESCE(inv.finalized, 0) > 0)::int AS has_finalized,
       count(*) FILTER (WHERE inv."orderId" IS NULL)::int AS no_invoice_at_all,
       count(*) FILTER (WHERE COALESCE(inv.untracked, 0) > 0)::int AS has_untracked_lines,
       min(oi."createdAt")::date AS first_line, max(oi."createdAt")::date AS last_line
FROM "OrderItem" oi
JOIN "Order" o ON o.id = oi."orderId"
LEFT JOIN "Tenant" t ON t.id = o."tenantId"
LEFT JOIN inv ON inv."orderId" = oi."orderId"
WHERE oi.status <> 'CANCELLED' AND o.status NOT IN ('CANCELLED', 'DRAFT') AND oi."deliveredQty" > 0
  AND NOT EXISTS (SELECT 1 FROM billed WHERE billed.id = oi.id)
GROUP BY 1 ORDER BY 1;
`;

export const UNBILLED_SQL_SHA256 = createHash("sha256").update(UNBILLED_SQL).digest("hex");

/** The queries, split at the SQL's own `-- Q<n> ` markers (Q1-Q3 for the census, Q4-Q8 for the denominators); each runs as written. */
export function splitCensusSql(text = CENSUS_SQL) {
  // The unbilled count is one plain SELECT with no `-- Q<n> ` markers: it runs whole, as written.
  if (text === UNBILLED_SQL) return [{ name: "unbilled", sql: text.trim() }];
  const parts = text.split(/^-- (?=Q\d )/m).slice(1);
  return parts.map((p) => ({
    name: p.slice(0, p.indexOf(" ")).toLowerCase(),
    sql: `-- ${p}`.trim(),
  }));
}

export function checkArgs(argv) {
  let timeoutS = DEFAULT_TIMEOUT_S;
  let denominators = false;
  let unbilled = false;
  for (const a of argv) {
    if (a === "--denominators") {
      denominators = true;
      continue;
    }
    if (a === "--unbilled") {
      unbilled = true;
      continue;
    }
    const m = /^--timeout-s=(\d+)$/.exec(a);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 1800) {
      return {
        ok: false,
        message: `unknown or invalid argument: ${a} (usage: [--denominators | --unbilled] [--timeout-s=<1-1800>])`,
      };
    }
    timeoutS = Number(m[1]);
  }
  if (denominators && unbilled) {
    return {
      ok: false,
      message: "--denominators and --unbilled are separate counts: run one at a time",
    };
  }
  return { ok: true, timeoutS, denominators, unbilled };
}

export async function runCensus(
  client,
  { timeoutS = DEFAULT_TIMEOUT_S, log = () => {}, denominators = false, unbilled = false } = {},
) {
  await client.query("SET default_transaction_read_only = on");
  const [{ transaction_read_only: ro }] = (await client.query("SHOW transaction_read_only")).rows;
  if (ro !== "on") throw Object.assign(new Error("session is not read-only"), { exitCode: 2 });
  await client.query(`SET statement_timeout = '${timeoutS}s'`);
  const out = {
    spec: unbilled
      ? { sqlCommit: UNBILLED_SQL_COMMIT, sqlSha256: UNBILLED_SQL_SHA256 }
      : denominators
        ? { sqlCommit: DENOMINATORS_SQL_COMMIT, sqlSha256: DENOMINATORS_SQL_SHA256 }
        : { sqlCommit: SPEC_SQL_COMMIT, sqlSha256: CENSUS_SQL_SHA256 },
    timingMs: {},
  };
  const t0 = Date.now();
  for (const q of splitCensusSql(
    unbilled ? UNBILLED_SQL : denominators ? DENOMINATORS_SQL : CENSUS_SQL,
  )) {
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
      denominators: args.denominators,
      unbilled: args.unbilled,
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
