// B681 correction routine -- DB access layer. Pure query/shaping functions, no CLI concerns
// (argv, stdout, process.exit) live here -- see b681-correct-ledger.mjs for those.
//
// Ground truth for the row shape and category logic: local-assets/handoff/2026-09-22/b681-sizing.sql
// (SA-058) and packages/pricing/src/b681-correction.ts's own header. This file is the per-ROW
// (not aggregated) version of that same SQL, plus the pack-evidence lookup
// (apps/api/src/returns/returns-restock-pieces.ts's loadInvoiceItems query, the SAME shape
// resolvePackFactors expects -- see line-pack-factors.ts).

/** Every SALE/REVERSAL row on a box-unaware line (no boxes/pieces/unitLabel split), with the
 *  shape/provenance evidence `computeLineCorrection` needs. One row per RegulatedSalesLedger row. */
export const BOX_UNAWARE_ROWS_SQL = `
  SELECT
    l.id, l."tenantId", l."trackedCategoryId", l."entryType",
    COALESCE(l."orderItemId", l."invoiceItemId") AS line_key,
    l."orderItemId", l."invoiceItemId",
    l.qty, l."unitBasisQty", l."netSales", l."categoryTax",
    l."soldAt", l."periodBucket", l."correctsEntryId",
    COALESCE(ii."boxes", oi."boxes")                              AS line_boxes,
    COALESCE(ii."pieces", oi."pieces")                            AS line_pieces,
    NULLIF(TRIM(COALESCE(ii."unitLabel", oi."unitLabel")), '')    AS line_unit_label,
    COALESCE(ii."unitsPerBox", oi."unitsPerBox")                  AS line_units_per_box,
    COALESCE(ii."productId", oi."productId")                      AS product_id,
    p."unitsPerBox"                                                AS product_pack_now,
    (f."id" IS NOT NULL)                                           AS in_generated_filing
  FROM "RegulatedSalesLedger" l
  LEFT JOIN "InvoiceItem" ii  ON ii."id" = l."invoiceItemId"
  LEFT JOIN "OrderItem"   oi  ON oi."id" = l."orderItemId"
  LEFT JOIN "Product"     p   ON p."id"  = COALESCE(ii."productId", oi."productId")
  LEFT JOIN "RegulatedFiling" f
         ON f."tenantId" = l."tenantId" AND f."trackedCategoryId" = l."trackedCategoryId"
        AND f."periodKey" = l."periodBucket" AND f."status" = 'GENERATED'
  WHERE l."entryType" IN ('SALE', 'REVERSAL')
    AND COALESCE(ii."boxes", oi."boxes") IS NULL
    AND COALESCE(ii."pieces", oi."pieces") IS NULL
    AND NULLIF(TRIM(COALESCE(ii."unitLabel", oi."unitLabel")), '') IS NULL
  ORDER BY line_key, l."soldAt"
`;

/** Prior B681 corrections already booked (idempotency -- see classifySaleAxis's own contract). */
export const PRIOR_CORRECTIONS_SQL = `
  SELECT id, "correctsEntryId", qty, "unitBasisQty"
  FROM "RegulatedSalesLedger"
  WHERE "correctsEntryId" = ANY($1::text[])
`;

/** Every live (non-VOID) InvoiceItem for the given order items -- the EXACT query
 *  `apps/api/src/returns/returns-restock-pieces.ts` uses to feed `resolvePackFactors`; this is the
 *  same pairing evidence, reused for the same reason (SA-069b: one source of truth for it). */
export const LIVE_INVOICE_ITEMS_SQL = `
  SELECT ii."orderItemId", ii.qty, ii.boxes, ii.pieces, ii."unitsPerBox"
  FROM "InvoiceItem" ii
  JOIN "Invoice" i ON i.id = ii."invoiceId"
  WHERE ii."orderItemId" = ANY($1::text[]) AND i.status <> 'VOID'
`;

/** Groups the flat SQL rows above into { lineKey -> { tenantId, rows: [...], orderItemId } }. */
export function groupByLineKey(flatRows) {
  const lines = new Map();
  for (const r of flatRows) {
    if (!lines.has(r.line_key)) {
      lines.set(r.line_key, {
        lineKey: r.line_key,
        tenantId: r.tenantId,
        trackedCategoryId: r.trackedCategoryId,
        orderItemId: r.orderItemId,
        productId: r.product_id,
        productPackNow: r.product_pack_now == null ? null : Number(r.product_pack_now),
        inGeneratedFiling: false,
        line: {
          boxes: r.line_boxes,
          pieces: r.line_pieces,
          unitLabel: r.line_unit_label,
          unitsPerBox: r.line_units_per_box,
        },
        rows: [],
      });
    }
    const entry = lines.get(r.line_key);
    entry.inGeneratedFiling = entry.inGeneratedFiling || r.in_generated_filing;
    entry.rows.push({
      id: r.id,
      entryType: r.entryType,
      qty: r.qty,
      unitBasisQty: r.unitBasisQty,
      netSales: r.netSales,
      categoryTax: r.categoryTax,
      soldAt: r.soldAt,
      periodBucket: r.periodBucket,
      correctsEntryId: r.correctsEntryId,
    });
  }
  return lines;
}

/** Picks the ONE live InvoiceItem source for a line's orderItemId, or null -- mirrors
 *  `resolvePackFactors`' own count-based refusal (0 or >1 candidates -> no source, never guessed). */
export function pickSourceLine(candidatesByOrderItem, orderItemId) {
  if (!orderItemId) return null;
  const candidates = candidatesByOrderItem.get(orderItemId) ?? [];
  if (candidates.length !== 1) return null;
  const c = candidates[0];
  return { qty: c.qty, boxes: c.boxes, pieces: c.pieces, unitsPerBox: c.unitsPerBox };
}
