import { periodBucketOf } from "./period";

/**
 * SA-089a/SA-134 shared fixture — the ONE case both correction paths must agree on byte-for-byte:
 * `ParkedReversalResolutionService`'s live resolution (this PR, #1324) and #1246/B681's
 * backfill script for legacy pre-B661 rows. Owned here (per the fleet lead's ruling on the
 * cross-lane pin) because #1324 is the live code path; #1246 imports `buildCorrectionCase` and
 * asserts its own script produces the same two rows this file describes.
 *
 * The scenario is SA-089a's own worked example (ii): a legacy 5-box line at pack 12, with 2 of
 * those boxes ALREADY returned via a LINE_UNIT (box-axis) reversal before the operator ever
 * resolves it. This is deliberately NOT the "fully voided" case (i) — that one closes with
 * NOTHING written (SA-089a(a)), so it has no correction rows for two paths to agree on.
 *
 * `now` is the caller's own frozen instant (SA-134: soldAt/periodBucket for EVERY correction row
 * derive from this SAME instant, never a separately-computed one) — injected rather than read
 * from `Date.now()` here, so both lanes' specs can pass a fixed value and get byte-identical
 * `soldAt`/`periodBucket` on their assertions.
 */
export interface CorrectionCaseSaleRow {
  id: string;
  tenantId: string;
  trackedCategoryId: string;
  trackedSubcategoryId: string | null;
  entryType: "SALE";
  orderId: string;
  orderItemId: string;
  invoiceId: string;
  invoiceItemId: string;
  correctsEntryId: null;
  qty: number;
  unitBasisQty: number;
  netSales: number;
  categoryTax: number;
  soldAt: Date;
}

export interface CorrectionCaseReversalRow {
  id: string;
  tenantId: string;
  trackedCategoryId: string;
  trackedSubcategoryId: string | null;
  entryType: "REVERSAL";
  orderId: string;
  orderItemId: string;
  invoiceId: string;
  invoiceItemId: string;
  correctsEntryId: null;
  returnId: string;
  qty: number;
  unitBasisQty: number;
  netSales: number;
  categoryTax: number;
  soldAt: Date;
}

/** The exact shape of a correction row EITHER path must produce — every column, no `id`
 *  (assigned at insert time by whichever path writes it). */
export interface ExpectedCorrectionRow {
  tenantId: string;
  trackedCategoryId: string;
  trackedSubcategoryId: string | null;
  entryType: "SALE" | "REVERSAL";
  orderId: string;
  orderItemId: string;
  invoiceId: string;
  invoiceItemId: string;
  correctsEntryId: string;
  originalSoldAt: Date;
  soldAt: Date;
  qty: number;
  unitBasisQty: number;
  netSales: number;
  categoryTax: number;
  periodBucket: string;
}

export interface CorrectionCase {
  tenantId: string;
  pack: number;
  sale: CorrectionCaseSaleRow;
  reversal: CorrectionCaseReversalRow;
  /** The parked row's own `returnedPieces` at resolve time (SA-089a(ii): 24 pieces requested). */
  resolvedReturnedPieces: number;
  /** Both expected correction rows, in write order: the SALE restatement, then the earlier
   *  reversal's own restatement. */
  expectedCorrections: [ExpectedCorrectionRow, ExpectedCorrectionRow];
  /** The derived figures SA-089a(ii) names explicitly, for either lane's own money assertions
   *  once its correction rows are written: remaining = (qty - Σr) * pack, booked = min(returned,
   *  remaining), and the line's ending balance. */
  expected: {
    saleCorrectionUnitBasisQty: number; // qty * (pack - 1)
    reversalCorrectionUnitBasisQty: number; // -|r| * (pack - 1)
    remainingAfterCorrections: number; // (qty - Σr) * pack
    bookedPieces: number; // min(resolvedReturnedPieces, remainingAfterCorrections)
    lineEndingBalance: number; // remainingAfterCorrections - bookedPieces
  };
}

/**
 * Builds the shared case. `now` is required (never defaulted to `Date.now()`) so two callers in
 * two different processes/lanes produce byte-identical `soldAt`/`periodBucket` when they pass
 * the same instant.
 */
export function buildCorrectionCase(now: Date): CorrectionCase {
  const tenantId = "t-sa089a-shared-fixture";
  const orderId = "ord-sa089a";
  const orderItemId = "oi-sa089a";
  const invoiceId = "inv-sa089a";
  const invoiceItemId = "ii-sa089a";
  const trackedCategoryId = "cat-sa089a";
  const saleId = "s-sa089a";
  const reversalId = "r-sa089a";
  const returnId = "ret-sa089a";
  const pack = 12;

  // qty = 5 selling units (boxes), legacy: unitBasisQty stored as a straight copy of qty (the
  // pre-B661 defect) — $50 net / $10 tax for the whole 5-box line.
  const qty = 5;
  const sale: CorrectionCaseSaleRow = {
    id: saleId,
    tenantId,
    trackedCategoryId,
    trackedSubcategoryId: null,
    entryType: "SALE",
    orderId,
    orderItemId,
    invoiceId,
    invoiceItemId,
    correctsEntryId: null,
    qty,
    unitBasisQty: qty,
    netSales: 50,
    categoryTax: 10,
    soldAt: new Date("2026-07-01T00:00:00.000Z"),
  };

  // r = 2 boxes already returned LINE_UNIT against the still-legacy sale — box-axis by
  // construction (|unitBasisQty| == |qty| == 2), 2/5 of the sale's money.
  const rBoxes = 2;
  const reversal: CorrectionCaseReversalRow = {
    id: reversalId,
    tenantId,
    trackedCategoryId,
    trackedSubcategoryId: null,
    entryType: "REVERSAL",
    orderId,
    orderItemId,
    invoiceId,
    invoiceItemId,
    correctsEntryId: null,
    returnId: "ret-prior-line-unit",
    qty: -rBoxes,
    unitBasisQty: -rBoxes,
    netSales: -20, // 2/5 of $50
    categoryTax: -4, // 2/5 of $10
    soldAt: new Date("2026-08-01T00:00:00.000Z"),
  };

  const periodBucket = periodBucketOf(now);
  const saleCorrectionUnitBasisQty = qty * (pack - 1); // 5 * 11 = 55
  const reversalCorrectionUnitBasisQty = -rBoxes * (pack - 1); // -2 * 11 = -22
  const remainingAfterCorrections = (qty - rBoxes) * pack; // (5-2)*12 = 36
  const resolvedReturnedPieces = 24;
  const bookedPieces = Math.min(resolvedReturnedPieces, remainingAfterCorrections); // 24
  const lineEndingBalance = remainingAfterCorrections - bookedPieces; // 12

  const saleCorrection: ExpectedCorrectionRow = {
    tenantId,
    trackedCategoryId,
    trackedSubcategoryId: null,
    entryType: "SALE",
    orderId,
    orderItemId,
    invoiceId,
    invoiceItemId,
    correctsEntryId: saleId,
    originalSoldAt: sale.soldAt,
    soldAt: now,
    qty: 0,
    unitBasisQty: saleCorrectionUnitBasisQty,
    netSales: 0,
    categoryTax: 0,
    periodBucket,
  };

  const reversalCorrection: ExpectedCorrectionRow = {
    tenantId,
    trackedCategoryId,
    trackedSubcategoryId: null,
    entryType: "REVERSAL",
    orderId,
    orderItemId,
    invoiceId,
    invoiceItemId,
    correctsEntryId: reversalId,
    originalSoldAt: reversal.soldAt,
    soldAt: now,
    qty: 0,
    unitBasisQty: reversalCorrectionUnitBasisQty,
    netSales: 0,
    categoryTax: 0,
    periodBucket,
  };

  return {
    tenantId,
    pack,
    sale,
    reversal,
    resolvedReturnedPieces,
    expectedCorrections: [saleCorrection, reversalCorrection],
    expected: {
      saleCorrectionUnitBasisQty,
      reversalCorrectionUnitBasisQty,
      remainingAfterCorrections,
      bookedPieces,
      lineEndingBalance,
    },
  };
}
