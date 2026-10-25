// B681 correction routine -- DB access layer, READ HALF ONLY (Q-D corrected-units sheet, SA-968 §3: the apply-only
// queries (FOR UPDATE re-read, existing-correction and parked-reversal checks) are not ported).
// B681 correction routine -- DB access layer. Pure query/shaping functions, no CLI concerns
// (argv, stdout, process.exit) live here -- see b681-correct-ledger.mjs for those.
//
// Ground truth for the row shape and category logic: local-assets/handoff/2026-09-22/b681-sizing.sql
// (SA-058) and packages/pricing/src/b681-correction.ts's own header. This file is the per-ROW
// (not aggregated) version of that same SQL, plus the pack-evidence lookup
// (apps/api/src/returns/returns-restock-pieces.ts's loadInvoiceItems query, the SAME shape
// resolvePackFactors expects -- see line-pack-factors.ts), plus the return-evidence lookup
// SA-076/FIX 1 needs (a RETURN-driven reversal's true returned pieces) and the per-row evidence
// hash SA-076a Ruling 2 requires (dry-run stamps it; apply re-derives and refuses on drift).
import { createHash } from "node:crypto";

/** The SELECT/FROM/JOIN body shared by the dry-run's all-lines scan and apply's scoped
 *  re-verification -- one place, so the two can never drift onto two different row shapes. */
const LEDGER_ROWS_SELECT = `
  SELECT
    l.id, l."tenantId", l."trackedCategoryId", l."entryType",
    COALESCE(l."orderItemId", l."invoiceItemId") AS line_key,
    l."orderItemId", l."invoiceItemId", l."returnId", l."creditNoteId",
    l.qty, l."unitBasisQty", l."netSales", l."categoryTax",
    l."soldAt", l."periodBucket", l."correctsEntryId", l."createdAt",
    COALESCE(ii."boxes", oi."boxes")                              AS line_boxes,
    COALESCE(ii."pieces", oi."pieces")                            AS line_pieces,
    NULLIF(TRIM(COALESCE(ii."unitLabel", oi."unitLabel")), '')    AS line_unit_label,
    COALESCE(ii."unitsPerBox", oi."unitsPerBox")                  AS line_units_per_box,
    CASE WHEN ii.id IS NOT NULL THEN 'invoiceItem' WHEN oi.id IS NOT NULL THEN 'orderItem' ELSE 'none' END
                                                                    AS which_line,
    COALESCE(ii.qty, oi.qty)                                       AS line_qty,
    COALESCE(ii."productId", oi."productId")                      AS product_id,
    (p.id IS NOT NULL)                                             AS product_found,
    p."unitsPerBox"                                                AS product_pack_now,
    (f."id" IS NOT NULL)                                           AS in_generated_filing
  FROM "RegulatedSalesLedger" l
  LEFT JOIN "InvoiceItem" ii  ON ii."id" = l."invoiceItemId"
  LEFT JOIN "OrderItem"   oi  ON oi."id" = l."orderItemId"
  LEFT JOIN "Product"     p   ON p."id"  = COALESCE(ii."productId", oi."productId")
  LEFT JOIN "RegulatedFiling" f
         ON f."tenantId" = l."tenantId" AND f."trackedCategoryId" = l."trackedCategoryId"
        AND f."periodKey" = l."periodBucket" AND f."status" = 'GENERATED'
`;

/** Every SALE/REVERSAL row on a box-unaware line (no boxes/pieces/unitLabel split), with the
 *  shape/provenance evidence `computeLineCorrection` needs. One row per RegulatedSalesLedger row.
 *  `which_line` says whether the shape came from the InvoiceItem or the OrderItem (or neither) --
 *  part of the SA-076a evidence hash. */
export const BOX_UNAWARE_ROWS_SQL = `
  ${LEDGER_ROWS_SELECT}
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
  SELECT ii.id, ii."orderItemId", ii.qty, ii.boxes, ii.pieces, ii."unitsPerBox"
  FROM "InvoiceItem" ii
  JOIN "Invoice" i ON i.id = ii."invoiceId"
  WHERE ii."orderItemId" = ANY($1::text[]) AND i.status <> 'VOID'
`;

/** Return.kind + the matching ReturnItem(s) (by productId) for the given returnIds -- SA-076
 *  FIX 1's "inline: ReturnItem pieces; standard: qty * the line's pack" evidence. More than one
 *  ReturnItem matching the same (returnId, productId) is treated as ambiguous by the caller
 *  (`pickReturnItem` below), same as an ambiguous pack source. */
export const RETURN_ITEMS_SQL = `
  SELECT r.id AS return_id, r.kind, ri."productId" AS product_id, ri.qty, ri.pieces
  FROM "Return" r
  JOIN "ReturnItem" ri ON ri."returnId" = r.id
  WHERE r.id = ANY($1::text[])
`;

/** For every (returnId, productId) pair, how many REGULATED REVERSAL rows anywhere in the ledger
 *  (any line, box-unaware or not) resolve to that same pair -- SA-076 FIX 1's attribution-
 *  uniqueness gate: a return item's pieces split across more than one reversal row cannot be
 *  attributed to just one of them, so that evidence must not be trusted for either. */
export const RETURN_REVERSAL_ATTRIBUTION_SQL = `
  SELECT l."returnId" AS return_id, COALESCE(ii."productId", oi."productId") AS product_id, COUNT(*)::int AS cnt
  FROM "RegulatedSalesLedger" l
  LEFT JOIN "InvoiceItem" ii ON ii.id = l."invoiceItemId"
  LEFT JOIN "OrderItem" oi ON oi.id = l."orderItemId"
  WHERE l."returnId" = ANY($1::text[]) AND l."entryType" = 'REVERSAL'
  GROUP BY l."returnId", COALESCE(ii."productId", oi."productId")
`;

/** Q4 (SA-076): the columns this routine depends on
 *  (20260921180000_ledger_correction_and_parked_reversals) -- asserted before building any plan,
 *  never assumed from the migrations table (a target can be schema-drifted from its own history). */
export const REQUIRED_COLUMNS_SQL = `
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_name IN ('RegulatedSalesLedger', 'RegulatedLedgerParkedReversal')
    AND column_name IN ('correctsEntryId', 'originalSoldAt', 'saleEntryId', 'returnedPieces')
`;

export async function assertRequiredColumns(client) {
  const rows = (await client.query(REQUIRED_COLUMNS_SQL)).rows;
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const need = [
    "RegulatedSalesLedger.correctsEntryId",
    "RegulatedSalesLedger.originalSoldAt",
    "RegulatedLedgerParkedReversal.saleEntryId",
    "RegulatedLedgerParkedReversal.returnedPieces",
  ];
  const missing = need.filter((n) => !have.has(n));
  if (missing.length > 0) {
    throw Object.assign(
      new Error(
        `target is missing column(s) this routine depends on: ${missing.join(", ")} -- apply migration 20260921180000_ledger_correction_and_parked_reversals first`,
      ),
      { refuse: true },
    );
  }
}

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
        // "omitted" (undefined) when no Product row was actually found (product_id null, or a
        // dangling id) -- legacyLinePieces/classifySaleAxis's own convention: a NOT-FOUND product
        // must be omitted, never passed as an explicit null (which means "product exists, no box
        // size" and decides "not boxed" on its own).
        productPackNow: r.product_found
          ? r.product_pack_now == null
            ? null
            : Number(r.product_pack_now)
          : undefined,
        inGeneratedFiling: false,
        line: {
          boxes: r.line_boxes,
          pieces: r.line_pieces,
          unitLabel: r.line_unit_label,
          unitsPerBox: r.line_units_per_box,
          which: r.which_line,
          qty: r.line_qty,
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
      returnId: r.returnId,
      creditNoteId: r.creditNoteId,
      createdAt: r.createdAt,
      // SA-609: the row's WRITE time, for classifySaleAxis (never soldAt, which can be back-dated).
      writtenAt: r.createdAt,
    });
  }
  return lines;
}

/** Picks the ONE live InvoiceItem source for a line's orderItemId, or null -- mirrors
 *  `resolvePackFactors`' own count-based refusal (0 or >1 candidates -> no source, never guessed).
 *  Also returns the candidate COUNT (0 when no orderItemId at all), for the evidence hash. */
export function pickSourceLine(candidatesByOrderItem, orderItemId) {
  if (!orderItemId) return { source: null, count: 0 };
  const candidates = candidatesByOrderItem.get(orderItemId) ?? [];
  if (candidates.length !== 1) return { source: null, count: candidates.length };
  const c = candidates[0];
  return {
    source: { qty: c.qty, boxes: c.boxes, pieces: c.pieces, unitsPerBox: c.unitsPerBox },
    count: 1,
    chosen: c,
  };
}

/** The ONE ReturnItem for (returnId, productId), or null when there isn't exactly one --
 *  ambiguous is refused, never guessed, same convention as `pickSourceLine`. */
export function pickReturnItem(returnItemsByPair, returnId, productId) {
  const key = `${returnId}::${productId}`;
  const candidates = returnItemsByPair.get(key) ?? [];
  return candidates.length === 1 ? candidates[0] : null;
}

/** Builds the `returnEvidence` object `computeLineCorrection` needs for one return-driven
 *  REVERSAL row (SA-076 FIX 1), or `null` when unresolved. */
export function buildReturnEvidence(row, returnItemsByPair, attributionByPair, productId) {
  if (!row.returnId) return undefined;
  const item = pickReturnItem(returnItemsByPair, row.returnId, productId);
  const attrKey = `${row.returnId}::${productId}`;
  const attributionUnique = (attributionByPair.get(attrKey) ?? 0) === 1;
  if (!item) {
    return { returnId: row.returnId, kind: "standard", qtyOrPieces: null, attributionUnique };
  }
  const kind = item.kind === "INLINE" ? "inline" : "standard";
  const qtyOrPieces =
    kind === "inline" ? (item.pieces == null ? null : Number(item.pieces)) : Number(item.qty);
  return { returnId: row.returnId, kind, qtyOrPieces, attributionUnique };
}

const strOf = (v) => (v == null ? null : String(Number(v)));

/**
 * SA-076a Ruling 2 -- the per-row evidence hash, EXACT contents (nothing added, nothing dropped):
 * the ledger row (qty, unitBasisQty, netSales, categoryTax, entryType, whether a correction
 * already points at it); the line's own shape (boxes, pieces, unitLabel, unitsPerBox, qty) from
 * the InvoiceItem else the OrderItem, plus which; the source-candidate set for deriveLinePack
 * (count of live non-VOID InvoiceItems on the line key; the chosen one's id, qty, boxes, pieces,
 * unitsPerBox); productPackNow as passed, null vs omitted distinguished; and for money the return
 * evidence (returnId, ReturnItem pieces or qty * pack, creditNoteId). Dry-run stamps this per
 * correction; apply re-derives it (after the row's FOR UPDATE lock) and refuses on any mismatch.
 */
export function computeRowEvidenceHash({
  row,
  hasExistingCorrection,
  lineShape,
  lineQty,
  sourceCandidateCount,
  chosenSource,
  productPackNow,
  returnEvidence,
  creditNoteId,
}) {
  const canon = {
    row: {
      qty: strOf(row.qty),
      unitBasisQty: strOf(row.unitBasisQty),
      netSales: strOf(row.netSales),
      categoryTax: strOf(row.categoryTax),
      entryType: row.entryType,
      hasExistingCorrection: !!hasExistingCorrection,
    },
    lineShape: {
      boxes: strOf(lineShape.boxes),
      pieces: strOf(lineShape.pieces),
      unitLabel: lineShape.unitLabel ?? null,
      unitsPerBox: strOf(lineShape.unitsPerBox),
      qty: strOf(lineQty),
      which: lineShape.which,
    },
    sourceCandidateCount,
    chosenSource: chosenSource
      ? {
          id: chosenSource.id,
          qty: strOf(chosenSource.qty),
          boxes: strOf(chosenSource.boxes),
          pieces: strOf(chosenSource.pieces),
          unitsPerBox: strOf(chosenSource.unitsPerBox),
        }
      : null,
    productPackNow: productPackNow === undefined ? "OMITTED" : strOf(productPackNow),
    // The RAW return evidence (kind + the ReturnItem's own qty or pieces, never pre-multiplied by
    // a pack this function doesn't derive) -- pack itself is already fully determined by
    // `sourceCandidateCount`/`chosenSource`/`lineShape` above, so recording it a second time here
    // would be redundant, not additional protection.
    returnEvidence: returnEvidence
      ? {
          returnId: returnEvidence.returnId,
          kind: returnEvidence.kind,
          qtyOrPieces: strOf(returnEvidence.qtyOrPieces),
          attributionUnique: returnEvidence.attributionUnique,
        }
      : null,
    creditNoteId: creditNoteId ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

/** Fetches every piece of evidence `groupByLineKey`'s output needs to become
 *  `computeLineCorrection` inputs and evidence hashes, for an already-fetched set of flat ledger
 *  rows (the dry run's full scan, or apply's scoped `LINE_ROWS_BY_KEY_FOR_UPDATE_SQL` read). One
 *  place, so dry-run and apply can never drift onto two different query sets for the same
 *  evidence. */
export async function buildLineContexts(client, flatRows) {
  const lines = groupByLineKey(flatRows);

  const orderItemIds = [...lines.values()].map((l) => l.orderItemId).filter(Boolean);
  const candidateRows =
    orderItemIds.length > 0
      ? (await client.query(LIVE_INVOICE_ITEMS_SQL, [orderItemIds])).rows
      : [];
  const candidatesByOrderItem = new Map();
  for (const c of candidateRows) {
    const list = candidatesByOrderItem.get(c.orderItemId);
    if (list) list.push(c);
    else candidatesByOrderItem.set(c.orderItemId, [c]);
  }

  const returnIds = [...new Set(flatRows.map((r) => r.returnId).filter(Boolean))];
  const returnItemRows =
    returnIds.length > 0 ? (await client.query(RETURN_ITEMS_SQL, [returnIds])).rows : [];
  const returnItemsByPair = new Map();
  for (const it of returnItemRows) {
    const key = `${it.return_id}::${it.product_id}`;
    const list = returnItemsByPair.get(key);
    if (list) list.push(it);
    else returnItemsByPair.set(key, [it]);
  }
  const attributionRows =
    returnIds.length > 0
      ? (await client.query(RETURN_REVERSAL_ATTRIBUTION_SQL, [returnIds])).rows
      : [];
  const attributionByPair = new Map();
  for (const a of attributionRows) {
    attributionByPair.set(`${a.return_id}::${a.product_id}`, a.cnt);
  }

  const rowIds = flatRows.map((r) => r.id);
  const priorCorrectionRows =
    rowIds.length > 0 ? (await client.query(PRIOR_CORRECTIONS_SQL, [rowIds])).rows : [];
  const priorByCorrectedRow = new Map();
  const rowsWithExistingCorrection = new Set(priorCorrectionRows.map((c) => c.correctsEntryId));
  for (const c of priorCorrectionRows) {
    const entry = { qty: c.qty, unitBasisQty: c.unitBasisQty };
    const list = priorByCorrectedRow.get(c.correctsEntryId);
    if (list) list.push(entry);
    else priorByCorrectedRow.set(c.correctsEntryId, [entry]);
  }

  return {
    lines,
    candidatesByOrderItem,
    returnItemsByPair,
    attributionByPair,
    priorByCorrectedRow,
    rowsWithExistingCorrection,
  };
}

/** For one line entry (from `buildLineContexts().lines`) and one of its rows, returns
 *  `{ returnEvidence, hashInputs }` -- `returnEvidence` is what `computeLineCorrection` needs
 *  (`undefined` for a non-return-driven row); `hashInputs` is the full input to
 *  `computeRowEvidenceHash`, reusable by the CLI for both the dry-run stamp and apply's
 *  re-verification. */
export function rowEvidence(entry, row, contexts) {
  const { source, count, chosen } = pickSourceLine(
    contexts.candidatesByOrderItem,
    entry.orderItemId,
  );
  const returnEvidence = buildReturnEvidence(
    row,
    contexts.returnItemsByPair,
    contexts.attributionByPair,
    entry.productId,
  );
  return {
    sourceLine: source,
    returnEvidence,
    hashInputs: {
      row,
      hasExistingCorrection: contexts.rowsWithExistingCorrection.has(row.id),
      lineShape: entry.line,
      lineQty: entry.line.qty,
      sourceCandidateCount: count,
      chosenSource: chosen ?? null,
      productPackNow: entry.productPackNow,
      returnEvidence,
      creditNoteId: row.creditNoteId ?? null,
    },
  };
}
