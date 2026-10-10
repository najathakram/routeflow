-- B681 sizing — READ-ONLY, per LINE KEY (SA-049), Senior Architect 2026-09-22.
-- Run: railway run --service postgres psql "$DATABASE_URL" -f b681-sizing.sql   (SELECT only; no writes)
-- A line key = COALESCE(orderItemId, invoiceItemId) of a ledger row (same key the ledger caps on).
-- Era is read from each ROW'S OWN CONTENT, never from a timestamp: on a box-unaware line of a
-- product boxed today (no boxes/pieces split, no unitLabel, unitsPerBox > 1), a row with
-- |unitBasisQty| = |qty| is on the BOX axis (pre-f45eaf52 SALE, or a credit/return reversal booked
-- on boxes); |unitBasisQty| > |qty| is on the PIECE axis. Timestamps are reported only as context:
-- f45eaf52 production success 06:42:43Z / 06:43:26Z; #1219 (294bcab6) success 11:07:33Z, 2026-09-22.
WITH rows_shaped AS (
  SELECT
    l."tenantId",
    l."trackedCategoryId",
    COALESCE(l."orderItemId", l."invoiceItemId")                       AS line_key,
    l."entryType", l."creditNoteId", l."returnId",
    l."periodBucket", l."soldAt",
    ABS(l."qty")                                                        AS aqty,
    ABS(l."unitBasisQty")                                               AS aubq,
    COALESCE(ii."boxes", oi."boxes")                                    AS boxes,
    COALESCE(ii."pieces", oi."pieces")                                  AS pieces,
    NULLIF(TRIM(COALESCE(ii."unitLabel", oi."unitLabel")), '')          AS unit_label,
    COALESCE(ii."productId", oi."productId")                            AS product_id,
    p."unitsPerBox"                                                     AS pack_now,
    inv."id"                                                            AS invoice_id,
    CASE
      WHEN inv."orderId" IS NOT NULL            THEN 'order-derived'
      WHEN inv."recurringInvoiceId" IS NOT NULL THEN 'recurring'
      WHEN est."id" IS NOT NULL                 THEN 'estimate-converted'
      WHEN inv."id" IS NOT NULL                 THEN 'manual-or-duplicate'   -- duplicate() leaves no marker
      ELSE 'no-invoice'
    END                                                                 AS provenance,
    (f."id" IS NOT NULL)                                                AS in_generated_filing
  FROM "RegulatedSalesLedger" l
  LEFT JOIN "InvoiceItem" ii  ON ii."id" = l."invoiceItemId"
  LEFT JOIN "OrderItem"   oi  ON oi."id" = l."orderItemId"
  LEFT JOIN "Product"     p   ON p."id"  = COALESCE(ii."productId", oi."productId")
  LEFT JOIN "Invoice"     inv ON inv."id" = l."invoiceId"
  LEFT JOIN "Estimate"    est ON est."invoiceId" = inv."id"
  LEFT JOIN "RegulatedFiling" f
         ON f."tenantId" = l."tenantId" AND f."trackedCategoryId" = l."trackedCategoryId"
        AND f."periodKey" = l."periodBucket" AND f."status" = 'GENERATED'
  WHERE l."entryType" IN ('SALE', 'REVERSAL')
),
box_unaware AS (
  -- Only lines that can carry the defect: no split, no unit label, product boxed TODAY.
  -- A boxed-at-sale line whose product is NOT boxed today is listed separately (unknown basis).
  SELECT * FROM rows_shaped
  WHERE boxes IS NULL AND pieces IS NULL AND unit_label IS NULL
),
per_line AS (
  SELECT
    "tenantId", "trackedCategoryId", line_key,
    MAX(provenance)                                                         AS provenance,
    BOOL_OR(pack_now > 1)                                                   AS boxed_now,
    COUNT(*) FILTER (WHERE "entryType" = 'SALE'     AND aubq = aqty)        AS sale_box_axis,
    COUNT(*) FILTER (WHERE "entryType" = 'SALE'     AND aubq > aqty)        AS sale_piece_axis,
    COUNT(*) FILTER (WHERE "entryType" = 'REVERSAL' AND aubq = aqty AND aqty > 0) AS rev_box_axis,
    COUNT(*) FILTER (WHERE "entryType" = 'REVERSAL' AND aubq > aqty)        AS rev_piece_axis,
    COUNT(*) FILTER (WHERE "creditNoteId" IS NOT NULL AND aubq = aqty AND aqty > 0
                       AND "soldAt" >= TIMESTAMPTZ '2026-09-22 06:42:43Z'
                       AND "soldAt" <  TIMESTAMPTZ '2026-09-22 11:07:33Z')   AS credit_rows_in_window_c,
    BOOL_OR(in_generated_filing)                                            AS touches_generated_filing,
    MIN("periodBucket")                                                     AS first_period,
    MAX("periodBucket")                                                     AS last_period
  FROM box_unaware
  GROUP BY "tenantId", "trackedCategoryId", line_key
),
classified AS (
  SELECT *,
    CASE
      WHEN NOT boxed_now THEN 'unknown-basis (product not boxed now)'
      WHEN sale_box_axis > 0 AND sale_piece_axis > 0 THEN 'straddles f45eaf52 (mixed SALE axes)'
      WHEN sale_box_axis > 0 AND rev_piece_axis > 0 THEN 'A+piece reversal (over-close risk)'
      WHEN sale_box_axis > 0                        THEN 'A (box-axis SALE, consistent reversals)'
      WHEN sale_piece_axis > 0 AND rev_box_axis > 0 THEN 'C (piece SALE, box-axis reversal)'
      ELSE 'clean (piece axis throughout)'
    END AS category
  FROM per_line
)
-- ONE statement (GROUPING SETS): the per-category/provenance breakdown PLUS a TOTAL row
-- (category/provenance NULL). "line_keys" on the TOTAL row is the number the owner needs.
SELECT category, provenance,
       COUNT(*)                                            AS line_keys,
       COUNT(*) FILTER (WHERE touches_generated_filing)    AS in_a_generated_filing,
       COUNT(*) FILTER (WHERE category LIKE 'straddles%')  AS straddling_lines,
       SUM(credit_rows_in_window_c)                        AS credit_note_rows_in_window_c,
       MIN(first_period) AS earliest_period, MAX(last_period) AS latest_period
FROM classified
WHERE category <> 'clean (piece axis throughout)'
GROUP BY GROUPING SETS ((category, provenance), ())
ORDER BY category NULLS LAST, provenance NULLS LAST;
