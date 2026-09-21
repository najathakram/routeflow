// The question set, the read-only guard and the runner of data-questions-report.mjs (CommonJS so the Jest
// spec can load it and drive the runner with a fake client). See that script's header for the contract.
"use strict";

const BOXED = `p."unitsPerBox" > 1`;
const UNAWARE = `oi.boxes IS NULL AND oi."unitsPerBox" IS NULL`;
/** Reversals summed PER ORDER LINE and kind, and one SALE total per line: the sale can never repeat per reversal row. */
const REV_SALE = `WITH rev AS (
           SELECT l."tenantId", l."orderItemId", r.kind::text AS kind,
                  count(*) AS reversal_rows, sum(abs(l."netSales")) AS reversed_net
           FROM "RegulatedSalesLedger" l JOIN "Return" r ON r.id = l."returnId"
           WHERE l."entryType" = 'REVERSAL' AND l."orderItemId" IS NOT NULL GROUP BY 1, 2, 3
         ), sale AS (
           SELECT s."orderItemId", sum(s."netSales") AS sale_net, sum(s.qty) AS sale_qty
           FROM "RegulatedSalesLedger" s
           WHERE s."entryType" = 'SALE' AND s."orderItemId" IN (SELECT "orderItemId" FROM rev) GROUP BY 1
         )`;
/** A route-delivered order with a live invoice and no payment on any invoice of it (closed on account). */
const ON_ACCOUNT_DELIVERED = `o."routeRunId" IS NOT NULL AND o.status IN ('DELIVERED', 'PARTIALLY_DELIVERED')
           AND EXISTS (SELECT 1 FROM "Invoice" i WHERE i."orderId" = o.id AND i.status <> 'VOID')
           AND NOT EXISTS (SELECT 1 FROM "Invoice" i JOIN "InvoicePayment" ip ON ip."invoiceId" = i.id WHERE i."orderId" = o.id)`;

const s = (label, sql) => ({ label, sql: sql.trim() });

/** n, the finding it measures, an optional approximation note, and its statements. */
const QUESTIONS = [
  {
    n: 1,
    bug: "B645",
    title: "boxed-product estimates converted to an invoice, then edited",
    approx:
      "edited = the invoice line was re-created >1 min after its invoice; dollars = per (invoice, product) invoice total minus the estimate total (no line key links the two)",
    stmts: [
      s(
        "converted estimates with boxed lines",
        `SELECT e."tenantId", count(DISTINCT e.id)::int AS estimates, count(*)::int AS boxed_lines
         FROM "Estimate" e JOIN "EstimateItem" ei ON ei."estimateId" = e.id JOIN "Product" p ON p.id = ei."productId"
         WHERE e.status = 'CONVERTED' AND e."invoiceId" IS NOT NULL AND ${BOXED}
         GROUP BY 1 ORDER BY 2 DESC`,
      ),
      s(
        "of those, split-less lines re-created after the invoice (12x risk)",
        // Both sides are summed per (estimate/invoice, product) BEFORE they are joined 1:1, so a product that
        // repeats on a document can never multiply rows or double-count dollars (review item 3). No line key links
        // an estimate line to its invoice line, so the conversion link is estimate -> invoice id, then product.
        `WITH aff AS (
           SELECT e.id AS estimate_id, e."tenantId", i.id AS invoice_id, ii."productId",
                  count(*) AS inv_lines, sum(ii.subtotal) AS inv_dollars
           FROM "Estimate" e JOIN "Invoice" i ON i.id = e."invoiceId"
             JOIN "InvoiceItem" ii ON ii."invoiceId" = i.id JOIN "Product" p ON p.id = ii."productId"
           WHERE e.status = 'CONVERTED' AND ${BOXED} AND ii.boxes IS NULL
             AND ii."createdAt" > i."createdAt" + interval '1 minute'
           GROUP BY 1, 2, 3, 4
         ), est AS (
           SELECT ei."estimateId" AS estimate_id, ei."productId", sum(ei.subtotal) AS est_dollars
           FROM "EstimateItem" ei WHERE ei."estimateId" IN (SELECT estimate_id FROM aff) GROUP BY 1, 2
         )
         SELECT aff."tenantId", sum(aff.inv_lines)::int AS lines, count(DISTINCT aff.invoice_id)::int AS invoices,
                sum(aff.inv_dollars - coalesce(est.est_dollars, 0))::numeric(14,2) AS invoice_minus_estimate_dollars
         FROM aff LEFT JOIN est ON est.estimate_id = aff.estimate_id AND est."productId" = aff."productId"
         GROUP BY 1 ORDER BY 4 DESC NULLS LAST`,
      ),
    ],
  },
  {
    n: 2,
    bug: "B646",
    title: "boxed-product recurring templates and the invoices they generated",
    approx:
      "pieces_understated assumes the stored qty is a BOX count (B646's reading); it is exposure, not proof",
    stmts: [
      s(
        "active templates with a boxed product",
        `SELECT r."tenantId", count(DISTINCT r.id)::int AS templates, count(*)::int AS boxed_lines
         FROM "RecurringInvoice" r JOIN "RecurringInvoiceItem" ri ON ri."recurringInvoiceId" = r.id
           JOIN "Product" p ON p.id = ri."productId"
         WHERE r."isActive" AND ${BOXED} GROUP BY 1 ORDER BY 2 DESC`,
      ),
      s(
        "generated invoices: split-less boxed lines (qty, billed dollars, pieces understated)",
        `SELECT i."tenantId", count(DISTINCT i.id)::int AS invoices, count(*)::int AS lines,
                sum(ii.qty)::numeric AS qty_as_stored, sum(ii.subtotal)::numeric(14,2) AS billed_dollars,
                sum(ii.qty * (p."unitsPerBox" - 1))::numeric AS pieces_understated_if_qty_is_boxes
         FROM "Invoice" i JOIN "InvoiceItem" ii ON ii."invoiceId" = i.id JOIN "Product" p ON p.id = ii."productId"
         WHERE i."recurringInvoiceId" IS NOT NULL AND i.status <> 'VOID' AND ${BOXED} AND ii.boxes IS NULL
         GROUP BY 1 ORDER BY 3 DESC`,
      ),
    ],
  },
  {
    n: 3,
    bug: "B647",
    title: "standing orders: cancelled or edited generated orders",
    approx:
      "order stock changes write no StockMovement row, so this is qty exposure per product, not a ledger reconciliation",
    stmts: [
      s(
        "generated orders by status",
        `SELECT o."tenantId", o.status::text AS status, count(*)::int AS orders
         FROM "Order" o WHERE o."templateId" IS NOT NULL GROUP BY 1, 2 ORDER BY 3 DESC`,
      ),
      s(
        "cancelled generated orders: line qty per product (stock a cancel may have credited but never taken)",
        `SELECT o."tenantId", oi."productId", count(*)::int AS lines, sum(oi.qty)::numeric AS qty
         FROM "Order" o JOIN "OrderItem" oi ON oi."orderId" = o.id
         WHERE o."templateId" IS NOT NULL AND o.status = 'CANCELLED' AND oi."productId" IS NOT NULL
         GROUP BY 1, 2 ORDER BY 4 DESC`,
      ),
      s(
        "generated orders that have an edit revision",
        `SELECT o."tenantId", count(DISTINCT o.id)::int AS edited_generated_orders
         FROM "Order" o JOIN "OrderRevision" r ON r."orderId" = o.id
         WHERE o."templateId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`,
      ),
    ],
  },
  {
    n: 4,
    bug: "A5",
    title: "deleteOrder history vs stock",
    approx:
      'a deleted order leaves no rows; the only trace is the request audit row ("DELETE /orders/:id", one per delete), so this counts deletes but cannot reconstruct their stock',
    stmts: [
      s(
        "audit traces of order deletion",
        `SELECT "tenantId", regexp_replace(action, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', ':id', 'g') AS action_pattern,
                count(*)::int AS deletes, min("createdAt")::date AS first_on, max("createdAt")::date AS last_on
         FROM "AuditLog" WHERE "entityType" ILIKE 'order%' AND action ILIKE '%delete%'
         GROUP BY 1, 2 ORDER BY 3 DESC`,
      ),
    ],
  },
  {
    n: 5,
    bug: "B655",
    title: "change requests resolved NEXT_DELIVERY, and the drafts they produced",
    approx: null,
    stmts: [
      s(
        "next-delivery resolutions",
        `SELECT cr."tenantId", cr.type::text AS type, count(*)::int AS requests,
                count(cr."nextOrderId")::int AS drafts_produced,
                count(*) FILTER (WHERE oi.boxes IS NOT NULL)::int AS on_box_split_line,
                sum(n.total)::numeric(14,2) AS drafts_total_dollars
         FROM "ChangeRequest" cr LEFT JOIN "OrderItem" oi ON oi.id = cr."orderItemId"
           LEFT JOIN "Order" n ON n.id = cr."nextOrderId"
         WHERE cr.resolution = 'NEXT_DELIVERY' GROUP BY 1, 2 ORDER BY 3 DESC`,
      ),
    ],
  },
  {
    n: 6,
    bug: "B656",
    title:
      "manual invoice lines with boxes set and unitsPerBox NULL (duplicate-then-edit exposure)",
    approx: "edited_after_create = the line row was rewritten >1 min after creation",
    stmts: [
      s(
        "boxed manual-invoice lines with no unitsPerBox snapshot",
        `SELECT ii."tenantId", i.status::text AS invoice_status, count(*)::int AS lines,
                count(DISTINCT i.id)::int AS invoices,
                count(*) FILTER (WHERE ii."updatedAt" > ii."createdAt" + interval '1 minute')::int AS edited_after_create
         FROM "InvoiceItem" ii JOIN "Invoice" i ON i.id = ii."invoiceId"
         WHERE ii.boxes IS NOT NULL AND ii."unitsPerBox" IS NULL AND i."orderId" IS NULL AND i.status <> 'VOID'
         GROUP BY 1, 2 ORDER BY 3 DESC`,
      ),
    ],
  },
  {
    n: 7,
    bug: "B657",
    title:
      "box-unaware order lines of boxed products, and driver CHANGE_QTY requests that touched them",
    approx: null,
    stmts: [
      s(
        "box-unaware lines (boxes NULL, unitsPerBox NULL) of boxed products on live orders",
        `SELECT o."tenantId", count(*)::int AS lines, count(DISTINCT o.id)::int AS orders
         FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId" JOIN "Product" p ON p.id = oi."productId"
         WHERE oi.boxes IS NULL AND oi."unitsPerBox" IS NULL AND ${BOXED} AND o.status <> 'CANCELLED'
         GROUP BY 1 ORDER BY 2 DESC`,
      ),
      s(
        "CHANGE_QTY requests (all; at-a-stop split out) on those lines",
        `SELECT cr."tenantId", count(*)::int AS requests,
                count(*) FILTER (WHERE cr."routeRunStopId" IS NOT NULL)::int AS at_a_stop
         FROM "ChangeRequest" cr JOIN "OrderItem" oi ON oi.id = cr."orderItemId" JOIN "Product" p ON p.id = oi."productId"
         WHERE cr.type = 'CHANGE_QTY' AND oi.boxes IS NULL AND oi."unitsPerBox" IS NULL AND ${BOXED}
         GROUP BY 1 ORDER BY 2 DESC`,
      ),
    ],
  },
  {
    n: 8,
    bug: "units",
    title: "legacy NULL-unitsPerBox invoice lines on ISSUED invoices of boxed products",
    approx: null,
    stmts: [
      s(
        "issued (non-draft, non-void) invoices",
        `SELECT ii."tenantId", count(*)::int AS lines, count(DISTINCT i.id)::int AS invoices
         FROM "InvoiceItem" ii JOIN "Invoice" i ON i.id = ii."invoiceId" JOIN "Product" p ON p.id = ii."productId"
         WHERE ii."unitsPerBox" IS NULL AND ${BOXED} AND i.status NOT IN ('DRAFT', 'VOID')
         GROUP BY 1 ORDER BY 2 DESC`,
      ),
    ],
  },
  {
    n: 9,
    bug: "B658",
    title: "standing orders with a tracked-category product: generated levy",
    approx:
      "estimated_levy covers PERCENT_OF_SALE categories only (rate x subtotal, price-includes-tax ignored); per-unit levies are reported as units",
    stmts: [
      s(
        "active standing orders containing a tracked-category product",
        `SELECT t."tenantId", count(DISTINCT t.id)::int AS templates, count(*)::int AS lines
         FROM "OrderTemplate" t JOIN "OrderTemplateItem" ti ON ti."templateId" = t.id JOIN "Product" p ON p.id = ti."productId"
         WHERE t."isActive" AND p."trackedCategoryId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`,
      ),
      s(
        "generated order lines on tracked categories: stored levy vs an estimate",
        `SELECT o."tenantId", tc."taxType"::text AS tax_type, count(*)::int AS lines,
                sum(oi."categoryTaxAmount")::numeric(14,2) AS stored_levy,
                sum(CASE WHEN tc."taxType"::text = 'PERCENT_OF_SALE' THEN oi.subtotal * tc.rate ELSE 0 END)::numeric(14,2) AS estimated_levy_percent_types,
                sum(CASE WHEN tc."taxType"::text <> 'PERCENT_OF_SALE' THEN oi.qty ELSE 0 END)::numeric AS per_unit_levy_qty
         FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId" JOIN "TrackedCategory" tc ON tc.id = oi."trackedCategoryId"
         WHERE o."templateId" IS NOT NULL AND o.status <> 'CANCELLED'
         GROUP BY 1, 2 ORDER BY 3 DESC`,
      ),
    ],
  },
  {
    n: 10,
    bug: "B659",
    title: "estimates converted to invoices that contain tracked-category products",
    approx: "same estimate as Q9 for percent levies",
    stmts: [
      s(
        "converted estimate lines on tracked categories vs the levy on the invoice line",
        `SELECT e."tenantId", tc."taxType"::text AS tax_type, count(*)::int AS lines, count(DISTINCT e.id)::int AS estimates,
                sum(ei.subtotal)::numeric(14,2) AS estimate_dollars,
                sum(ii."categoryTaxAmount")::numeric(14,2) AS invoice_levy,
                sum(CASE WHEN tc."taxType"::text = 'PERCENT_OF_SALE' THEN ei.subtotal * tc.rate ELSE 0 END)::numeric(14,2) AS estimated_levy_percent_types
         FROM "Estimate" e JOIN "EstimateItem" ei ON ei."estimateId" = e.id JOIN "Product" p ON p.id = ei."productId"
           JOIN "TrackedCategory" tc ON tc.id = p."trackedCategoryId"
           LEFT JOIN "InvoiceItem" ii ON ii."invoiceId" = e."invoiceId" AND ii."productId" = ei."productId"
         WHERE e.status = 'CONVERTED' GROUP BY 1, 2 ORDER BY 3 DESC`,
      ),
    ],
  },
  {
    n: 11,
    bug: "B664",
    title: "products with unitsPerBox = 1, and zero-qty invoice lines with a product",
    approx: null,
    stmts: [
      s(
        "active products with unitsPerBox = 1",
        `SELECT "tenantId", count(*)::int AS products FROM "Product"
         WHERE "unitsPerBox" = 1 AND "isActive" GROUP BY 1 ORDER BY 2 DESC`,
      ),
      s(
        "invoice lines with qty = 0 and a productId on non-void invoices",
        `SELECT ii."tenantId", count(*)::int AS lines, count(DISTINCT i.id)::int AS invoices,
                sum(ii.subtotal)::numeric(14,2) AS subtotal_dollars
         FROM "InvoiceItem" ii JOIN "Invoice" i ON i.id = ii."invoiceId"
         WHERE ii.qty = 0 AND ii."productId" IS NOT NULL AND i.status <> 'VOID'
         GROUP BY 1 ORDER BY 2 DESC`,
      ),
    ],
  },
  {
    n: 12,
    bug: "B660",
    title: "regulated ledger REVERSAL rows vs the SALE they reverse, by return path",
    approx:
      "reversals are summed PER ORDER LINE before the sale is joined (one sale per line and kind); reversed_pct near 100 with a partial return is the over-reversal signature. INLINE returns are keyed to the line (ReturnItem.sourceOrderItemId); STANDARD returns store no line key, so they are matched by productId inside the return's order and only when that product is on exactly ONE order line (others are counted as unmatched)",
    stmts: [
      s(
        "box-unaware boxed lines: share of the SALE net reversed, by return kind",
        `${REV_SALE}
         SELECT rev."tenantId", rev.kind AS return_kind, count(*)::int AS lines,
                sum(rev.reversal_rows)::int AS reversal_rows, sum(rev.reversed_net)::numeric(14,2) AS reversed_net,
                sum(sale.sale_net)::numeric(14,2) AS sale_net,
                round(100 * sum(rev.reversed_net) / nullif(sum(sale.sale_net), 0), 1) AS reversed_pct,
                count(*) FILTER (WHERE rev.reversed_net >= sale.sale_net * 0.99)::int AS lines_fully_reversed
         FROM rev JOIN sale ON sale."orderItemId" = rev."orderItemId"
           JOIN "OrderItem" oi ON oi.id = rev."orderItemId" JOIN "Product" p ON p.id = oi."productId"
         WHERE ${UNAWARE} AND ${BOXED} GROUP BY 1, 2 ORDER BY 3 DESC`,
      ),
      s(
        "INLINE returns (exact line key): fully reversed although fewer pieces came back than were sold",
        `${REV_SALE},
         ret AS (
           SELECT x."sourceOrderItemId" AS "orderItemId", sum(x.qty) AS returned_pieces
           FROM "ReturnItem" x JOIN "Return" r ON r.id = x."returnId"
           WHERE r.kind::text = 'INLINE' AND x."sourceOrderItemId" IN (SELECT "orderItemId" FROM rev) GROUP BY 1
         )
         SELECT rev."tenantId", count(*)::int AS lines, sum(ret.returned_pieces)::numeric AS returned_pieces,
                sum(sale.sale_qty * p."unitsPerBox")::numeric AS sold_pieces_if_sale_qty_is_boxes,
                count(*) FILTER (WHERE rev.reversed_net >= sale.sale_net * 0.99
                                   AND ret.returned_pieces < sale.sale_qty * p."unitsPerBox")::int AS fully_reversed_but_partly_returned,
                count(*) FILTER (WHERE ret.returned_pieces IS NULL)::int AS unmatched_lines
         FROM rev JOIN sale ON sale."orderItemId" = rev."orderItemId" LEFT JOIN ret ON ret."orderItemId" = rev."orderItemId"
           JOIN "OrderItem" oi ON oi.id = rev."orderItemId" JOIN "Product" p ON p.id = oi."productId"
         WHERE rev.kind = 'INLINE' AND ${UNAWARE} AND ${BOXED} GROUP BY 1 ORDER BY 2 DESC`,
      ),
      s(
        "STANDARD returns (matched by product within the order; single-line products only): same test in the line's own unit",
        `${REV_SALE},
         ret AS (
           SELECT oi.id AS "orderItemId", sum(x.qty) AS returned_qty
           FROM "ReturnItem" x JOIN "Return" r ON r.id = x."returnId" AND r.kind::text = 'STANDARD'
             JOIN "OrderItem" oi ON oi."orderId" = r."orderId" AND oi."productId" = x."productId"
           WHERE oi.id IN (SELECT "orderItemId" FROM rev)
             AND (SELECT count(*) FROM "OrderItem" o2 WHERE o2."orderId" = oi."orderId" AND o2."productId" = oi."productId") = 1
           GROUP BY 1
         )
         SELECT rev."tenantId", count(*)::int AS lines, sum(ret.returned_qty)::numeric AS returned_qty_line_unit,
                sum(sale.sale_qty)::numeric AS sale_qty,
                count(*) FILTER (WHERE rev.reversed_net >= sale.sale_net * 0.99 AND ret.returned_qty < sale.sale_qty)::int AS fully_reversed_but_partly_returned,
                count(*) FILTER (WHERE ret.returned_qty IS NULL)::int AS unmatched_lines
         FROM rev JOIN sale ON sale."orderItemId" = rev."orderItemId" LEFT JOIN ret ON ret."orderItemId" = rev."orderItemId"
           JOIN "OrderItem" oi ON oi.id = rev."orderItemId" JOIN "Product" p ON p.id = oi."productId"
         WHERE rev.kind = 'STANDARD' AND ${UNAWARE} AND ${BOXED} GROUP BY 1 ORDER BY 2 DESC`,
      ),
    ],
  },
  {
    n: 13,
    bug: "B663",
    title: "deliveries closed on account (no payment) with a short or refused line",
    approx:
      "OrderItem.deliveredQty is NOT NULL DEFAULT 0, so 'delivered 0' (refused) cannot be told from 'never recorded': the two buckets are reported SEPARATELY. Bucket 1 (0 < deliveredQty < qty) is unambiguous evidence of a recorded short. Delivered-basis dollars are qty x unitPrice: exact for non-boxed lines only, so boxed lines are counted separately",
    stmts: [
      s(
        "bucket 1 (recorded short, non-boxed): dollars billed at the ordered qty beyond what was delivered",
        `SELECT o."tenantId", count(DISTINCT o.id)::int AS orders, count(*)::int AS short_lines,
                sum((oi.qty - oi."deliveredQty") * oi."unitPrice")::numeric(14,2) AS overbilled_if_invoice_at_ordered_qty
         FROM "Order" o JOIN "OrderItem" oi ON oi."orderId" = o.id LEFT JOIN "Product" p ON p.id = oi."productId"
         WHERE ${ON_ACCOUNT_DELIVERED} AND oi.status <> 'CANCELLED'
           AND oi."deliveredQty" > 0 AND oi."deliveredQty" < oi.qty AND (p."unitsPerBox" IS NULL OR p."unitsPerBox" <= 1)
         GROUP BY 1 ORDER BY 4 DESC NULLS LAST`,
      ),
      s(
        "bucket 2 (deliveredQty = 0: REFUSED or NEVER RECORDED, indistinguishable; split by a DeliveryMutation row on the line)",
        `SELECT o."tenantId", count(DISTINCT o.id)::int AS orders, count(*)::int AS zero_delivered_lines,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "DeliveryMutation" dm WHERE dm."orderItemId" = oi.id))::int AS with_delivery_mutation,
                sum(oi.qty * oi."unitPrice") FILTER (WHERE EXISTS (SELECT 1 FROM "DeliveryMutation" dm WHERE dm."orderItemId" = oi.id))::numeric(14,2) AS dollars_with_mutation,
                sum(oi.qty * oi."unitPrice")::numeric(14,2) AS dollars_all_zero_delivered
         FROM "Order" o JOIN "OrderItem" oi ON oi."orderId" = o.id LEFT JOIN "Product" p ON p.id = oi."productId"
         WHERE ${ON_ACCOUNT_DELIVERED} AND oi.status <> 'CANCELLED'
           AND oi."deliveredQty" = 0 AND oi.qty > 0 AND (p."unitsPerBox" IS NULL OR p."unitsPerBox" <= 1)
         GROUP BY 1 ORDER BY 6 DESC NULLS LAST`,
      ),
      s(
        "boxed lines, both buckets (counted only)",
        `SELECT o."tenantId", count(DISTINCT o.id)::int AS orders, count(*)::int AS short_boxed_lines,
                count(*) FILTER (WHERE oi."deliveredQty" = 0)::int AS zero_delivered
         FROM "Order" o JOIN "OrderItem" oi ON oi."orderId" = o.id JOIN "Product" p ON p.id = oi."productId"
         WHERE ${ON_ACCOUNT_DELIVERED} AND oi.status <> 'CANCELLED' AND oi."deliveredQty" < oi.qty AND ${BOXED}
         GROUP BY 1 ORDER BY 2 DESC`,
      ),
    ],
  },
  {
    n: 14,
    bug: "B666",
    title: "batch-imported vendor bills with a boxed product and no packSize",
    approx:
      "pieces_missing = qtyReceived x (unitsPerBox - 1); the averageCost effect is not recomputed here",
    stmts: [
      s(
        "batch-imported bill lines: boxed product, packSize NULL",
        `SELECT b."tenantId", count(DISTINCT b.id)::int AS bills, count(*)::int AS lines,
                sum(vi."qtyReceived" * (p."unitsPerBox" - 1))::numeric AS pieces_missing,
                sum(vi."lineTotal")::numeric(14,2) AS line_dollars
         FROM "ImportQueueItem" q JOIN "VendorBill" b ON b.id = q."vendorBillId"
           JOIN "VendorBillItem" vi ON vi."vendorBillId" = b.id JOIN "Product" p ON p.id = vi."productId"
         WHERE vi."packSize" IS NULL AND ${BOXED} AND b.status <> 'VOID'
         GROUP BY 1 ORDER BY 3 DESC`,
      ),
    ],
  },
  {
    n: 15,
    bug: "B667",
    title: "orders exposed to the partial-invoice orphan cancel",
    approx:
      "the already-cancelled signature (CANCELLED, qty 0, invoicedQty 0, subtotal 0 on an invoiced order) also matches a deliberate cancel",
    stmts: [
      s(
        "orders with a non-void invoice and a live line where invoicedQty < qty",
        `SELECT o."tenantId", count(DISTINCT o.id)::int AS exposed_orders, count(*)::int AS exposed_lines,
                count(DISTINCT o.id) FILTER (WHERE EXISTS (SELECT 1 FROM "Invoice" d WHERE d."orderId" = o.id AND d.status = 'DRAFT'))::int AS with_an_editable_draft
         FROM "Order" o JOIN "OrderItem" oi ON oi."orderId" = o.id
         WHERE oi.status <> 'CANCELLED' AND oi."invoicedQty" < oi.qty
           AND EXISTS (SELECT 1 FROM "Invoice" i WHERE i."orderId" = o.id AND i.status <> 'VOID')
         GROUP BY 1 ORDER BY 2 DESC`,
      ),
      s(
        "already-cancelled signature on invoiced orders",
        `SELECT o."tenantId", count(DISTINCT o.id)::int AS orders, count(*)::int AS lines
         FROM "Order" o JOIN "OrderItem" oi ON oi."orderId" = o.id
         WHERE oi.status = 'CANCELLED' AND oi.qty = 0 AND oi."invoicedQty" = 0 AND oi.subtotal = 0
           AND EXISTS (SELECT 1 FROM "Invoice" i WHERE i."orderId" = o.id AND i.status <> 'VOID')
         GROUP BY 1 ORDER BY 2 DESC`,
      ),
    ],
  },
  {
    n: 16,
    bug: "B665",
    title: "standard returns of box-unaware lines already restocked",
    approx:
      "assumes the operator typed BOXES for a box-unaware line (R-ui's unverified premise); deficit_pieces = quantity x (unitsPerBox - 1)",
    stmts: [
      s(
        "RETURN stock movements from standard returns against box-unaware boxed lines",
        // Each movement is counted ONCE: order lines are tested with EXISTS, never joined, so several order lines
        // of one product cannot multiply restocked_qty or the deficit (review item 4). A product that is on both a
        // box-aware and a box-unaware line of the same order is ambiguous and excluded.
        `SELECT m."tenantId", count(DISTINCT m.id)::int AS movements, sum(m.quantity)::numeric AS restocked_qty,
                sum(m.quantity * (p."unitsPerBox" - 1))::numeric AS deficit_pieces_if_typed_in_boxes
         FROM "StockMovement" m
           JOIN "Return" r ON m.reference = 'RET-' || left(r.id::text, 8) AND r.kind::text = 'STANDARD'
           JOIN "Product" p ON p.id = m."productId"
         WHERE m.type::text = 'RETURN' AND ${BOXED}
           AND EXISTS (SELECT 1 FROM "OrderItem" oi WHERE oi."orderId" = r."orderId" AND oi."productId" = m."productId"
                         AND oi.boxes IS NULL AND oi."unitsPerBox" IS NULL)
           AND NOT EXISTS (SELECT 1 FROM "OrderItem" oa WHERE oa."orderId" = r."orderId" AND oa."productId" = m."productId"
                         AND (oa.boxes IS NOT NULL OR oa."unitsPerBox" IS NOT NULL))
         GROUP BY 1 ORDER BY 2 DESC`,
      ),
    ],
  },
];

const READ_ONLY = /^\s*(select|with)\b/i;
const WRITES =
  /\b(insert|update|delete|truncate|alter|create|drop|grant|revoke|copy|merge|call|do)\b/i;
/** Transaction control has no place inside a report statement (a lone END is impossible: no ";" and SELECT/WITH only). */
const TX_CONTROL =
  /\b(commit|rollback|abort|begin|savepoint|release|start\s+transaction|set\s+(transaction|session|local|role))\b/i;
/** Every statement: ONE SELECT/WITH, no semicolon, no transaction control, no write keyword (the spec re-checks). */
function assertReadOnly(sql) {
  const bare = sql.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  if (bare.includes(";"))
    throw new Error(`refusing a statement containing a semicolon: ${sql.slice(0, 80)}`);
  if (TX_CONTROL.test(bare))
    throw new Error(`refusing transaction control in a statement: ${sql.slice(0, 80)}`);
  if (!READ_ONLY.test(sql) || WRITES.test(bare))
    throw new Error(`refusing non-read-only statement: ${sql.slice(0, 80)}`);
}

function parseOnly(arg) {
  if (!arg) return null;
  const ns = arg.split(",").map((x) => Number(x.trim()));
  if (ns.some((n) => !Number.isInteger(n) || !QUESTIONS.some((q) => q.n === n)))
    throw new Error(`--only takes question numbers 1-${QUESTIONS.length}, got "${arg}"`);
  return new Set(ns);
}

/**
 * Run the questions on an already-connected `client`. `log` receives the DETAIL lines (they hold tenant and
 * product ids: the caller writes them to a private file). Returns an id-free SUMMARY for stdout. Never writes.
 */
async function runReport(
  client,
  { only = null, cap = 100, timeoutMs = 30000, lockTimeoutMs = 2000 } = {},
  log = console.log,
) {
  const summary = [];
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
    for (const q of QUESTIONS) {
      if (only && !only.has(q.n)) continue;
      log(`\n== question ${q.n} (${q.bug}): ${q.title}`);
      if (q.approx) log(`   approx: ${q.approx}`);
      const sq = { n: q.n, bug: q.bug, statements: 0, rows: 0, failed: 0, capped: 0 };
      summary.push(sq);
      let idx = 0;
      for (const st of q.stmts) {
        const sp = `q${q.n}_${idx++}`;
        sq.statements++;
        try {
          await client.query(`SAVEPOINT ${sp}`);
          const { rows } = await client.query(
            `SELECT * FROM (\n${st.sql}\n) capped LIMIT ${cap + 1}`,
          );
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          const capped = rows.length > cap;
          sq.rows += Math.min(rows.length, cap);
          if (capped) sq.capped++;
          log(`   -- ${st.label}: ${capped ? `${cap}+ rows (CAPPED)` : `${rows.length} row(s)`}`);
          for (const r of rows.slice(0, cap)) log(`   ${JSON.stringify(r)}`);
        } catch (e) {
          sq.failed++;
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => undefined);
          log(`   question ${q.n}: FAILED (${st.label}) ${String(e.message).split("\n")[0]}`);
        }
      }
    }
    return summary;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}

/** Connect, run, and ALWAYS close the client (also when BEGIN or a SET fails: then no question has run). */
async function execute(client, opts, log) {
  try {
    await client.connect();
    return await runReport(client, opts, log);
  } finally {
    await client.end().catch(() => undefined);
  }
}

module.exports = { QUESTIONS, assertReadOnly, parseOnly, runReport, execute };
