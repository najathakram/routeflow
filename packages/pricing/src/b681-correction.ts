/**
 * B681 correction routine's money-critical core (Senior Architect ruling 2026-09-22, SA-058
 * through SA-076a). Pure functions only -- no DB, no `new Date()`, no I/O. The CLI
 * (`apps/api/scripts/b681-correct-ledger.mjs`) is a thin DB-facing wrapper around this: it reads
 * rows and return evidence, calls these, and writes exactly the corrections/parked rows they
 * return.
 *
 * THREE jobs, kept separate because their risk is different:
 *
 *   1. `deriveLinePack` -- the SAME pairing pattern as `apps/api/src/common/line-pack-factors.ts`'s
 *      `resolvePackFactors` (SA-069b: copy verbatim, this comment names that file as the source of
 *      truth; a parity spec, `apps/api/src/common/line-pack-factors.parity.spec.ts`, proves the two
 *      answer identically), scoped to ONE line instead of a batch. Never multiplies by a live
 *      product's pack directly -- derives a WHOLE-NUMBER factor from the ONE live sibling
 *      InvoiceItem's own split, via `legacyLinePieces`. `unknown` -> the line PARKS, never guessed.
 *
 *   2. AXIS correction -- `qty` (the line's own unit -- boxes, or whatever `unitLabel` names) is
 *      NEVER wrong on a SALE row, and is wrong on a REVERSAL row ONLY in the one over-close shape
 *      job 3 below detects. So `unitBasisQty` corrects to `qty * pack`, signed like the row's own
 *      `qty`, for every row EXCEPT a REVERSAL this module could not prove safe (see job 3) --
 *      those are left untouched here and parked instead.
 *
 *   3. MONEY correction (SA-076, "Q1") -- `netSales`/`categoryTax` on a SALE row are the line's own
 *      post-discount subtotal/tax, never axis-dependent, and are never corrected. A REVERSAL row's
 *      money CAN be wrong, and — this is the SA-066(1) finding that overturned this module's first
 *      version — a REVERSAL that reads axis-CONSISTENT with its SALE (`|unitBasisQty| ==
 *      |qty|`, this module's own `axisOfReversal`) is NOT proof it is correct: `regulated-
 *      ledger.service.ts`'s return-driven reversal path (`reverseReturnEntries`, `returnedUnit:
 *      "PIECES"`) computes `closesRow = remaining >= rowRemainingNative` against the SALE's own
 *      (possibly box-axis-wrong, i.e. too SMALL) `unitBasisQty` as `rowRemainingNative` -- so an
 *      ordinary PARTIAL return can trip `closesRow` early and book the line's FULL remaining
 *      qty/unitBasisQty/net/tax for a return that only covered a fraction of it. That over-closed
 *      reversal reads perfectly axis-consistent (it IS the SALE's own wrong qty, negated) — "fully
 *      netted, Σqty = 0" is that bug's exact signature, not evidence the line is fine.
 *
 *      So for every RETURN-driven reversal (one whose own `returnId` is set — the ONE path with
 *      this defect; see below for why a credit-note- or void-driven reversal doesn't have it), this
 *      module compares the booked share against the return's OWN true returned amount (inline: its
 *      `ReturnItem.pieces`; standard: its `ReturnItem.qty * this line's pack`) and trusts THAT, not
 *      the ratio. A mismatch on a line with exactly one SALE row and exactly one reversal is money
 *      (and BOTH quantity axes of that one reversal) well-defined without replaying any historical
 *      write-time "remaining" state: `targetNet = SALE net * (returned / sold)`, capped at the
 *      remaining (which for a single reversal on a single sale is the sale's own full net);
 *      `delta = target - booked`, same for `categoryTax`, `unitBasisQty` and `qty`. A mismatch on
 *      any line with more than one SALE row or more than one reversal is NOT resolved here -- which
 *      SALE row or which prior reversal a given return chunk belongs to cannot be reconstructed from
 *      the stored rows alone, so it PARKS instead of guessing.
 *
 *      A credit-note-driven reversal (`creditNoteId` set, `returnId` null) does NOT have this
 *      defect: `reverseCreditNoteEntries` derives its `unitBasisQty` from the credited SALE row's
 *      own live `unitBasis / qty` ratio applied to the CreditNoteItem's own `qty` (the line's own
 *      unit, never a piece-native "remaining" comparison) — so it stays proportionally CONSISTENT
 *      with whatever axis the SALE is on, never over-closes independently of it, and this module's
 *      ratio-based `axisOfReversal` correctly classifies it (unchanged from the first version).
 *
 *      SA-076 FIX 2: axis-correcting a line's SALE row to read piece-axis, while leaving its money
 *      unresolved, is not a safe resting state — the SA-061 filing gate trusts a line once its axis
 *      reads piece-axis, so an axis-only fix on a line with declined money silently drops the guard
 *      that would otherwise have caught the wrong net/tax. So every RETURN-driven reversal on a
 *      line whose money question was NOT resolved (a mismatch outside the single-SALE/single-
 *      reversal shape, or unavailable/ambiguous return evidence) is reported in `parkedReversals`
 *      for the CLI to write a `RegulatedLedgerParkedReversal` row against — the SAME table and gate
 *      `apps/api/src/regulated/parked-reversals.ts` already enforces, so filing stays blocked until
 *      #1218's resolver actually clears it. A line whose only return-driven reversal(s) all PROVABLY
 *      MATCH (and any non-return-driven reversal is axis-consistent) needs no parking: its money was
 *      never in question. `RegulatedLedgerParkedReversal.returnId` is NOT NULL in the schema, so
 *      this mechanism only covers return-driven reversals -- a credit-note-driven reversal on a
 *      money-declined line has no equivalent gate yet; the CLI reports that gap rather than silently
 *      dropping it (see the CLI's own header).
 *
 * Every numeric field is read through `Number()` with a finite check, same convention as
 * `legacy-box-axis.ts`'s `finiteOrNull` -- a Prisma `Decimal` compared with `===` against a plain
 * `number` is always `false`.
 */

import { legacyLinePieces, type LegacyLine } from "./legacy-line-pieces";
import { classifySaleAxis, type SaleAxisCorrection, type SaleAxisLine } from "./legacy-box-axis";
import { roundMoney } from "./pricing";

const EPS = 0.0005;

function finiteOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export type B681PackResult = { factor: number } | { unknown: true; reason: string };

/** A line as `deriveLinePack` needs it -- the row's own linked InvoiceItem/OrderItem, same shape
 *  `classifySaleAxis` reads (`SaleAxisLine`) plus `qty` (the pack ratio's own denominator). */
export interface B681Line extends SaleAxisLine {
  qty: unknown;
}

/** `deriveLinePack` -- see this file's header. Mirrors `line-pack-factors.ts`'s `resolvePackFactors`
 *  body verbatim (that file is the source of truth for this pairing rule), for exactly one line. */
export function deriveLinePack(
  line: B681Line,
  sourceLine: B681Line | null,
  productPackNow?: number | null,
): B681PackResult {
  const qty = finiteOrNull(line.qty);
  if (qty == null || !(qty > 0)) {
    return { unknown: true, reason: "line has no positive qty to derive a pack from" };
  }
  const asLegacy = (x: B681Line): LegacyLine => ({
    qty: Number(x.qty),
    boxes: (x.boxes ?? null) as number | null,
    pieces: (x.pieces ?? null) as number | null,
    unitsPerBox: (x.unitsPerBox ?? null) as number | null,
  });
  const unitsPerBox = finiteOrNull(line.unitsPerBox);
  const snapshotProvesBoxedAtSale = unitsPerBox != null && unitsPerBox > 1;
  const res = legacyLinePieces(asLegacy(line), sourceLine ? asLegacy(sourceLine) : null, {
    relation: "full",
    ...(productPackNow !== undefined && !snapshotProvesBoxedAtSale ? { productPackNow } : {}),
  });
  if ("unknown" in res) {
    return { unknown: true, reason: res.reason };
  }
  const factor = res.pieces / qty;
  if (!Number.isInteger(factor) || factor < 1) {
    return {
      unknown: true,
      reason: `derived pack (${res.pieces} pieces over ${qty}) is not a whole number of pieces per unit`,
    };
  }
  return { factor };
}

/** The return evidence for ONE return-driven REVERSAL row -- present only when the row's own
 *  `returnId` is set (see this file's header for why only that path needs it). */
export interface B681ReturnEvidence {
  returnId: string;
  kind: "standard" | "inline";
  /** STANDARD: the matching `ReturnItem.qty` (the line's own unit -- multiplied by this line's
   *  derived pack below). INLINE: the matching `ReturnItem.pieces` directly, never multiplied.
   *  `null` when unresolved (no matching ReturnItem, or an inline row whose own split was never
   *  captured) -- NOT the same as `0`. */
  qtyOrPieces: number | null;
  /** `false` when this (returnId, product) pair's evidence is shared across more than one
   *  regulated REVERSAL row anywhere in the ledger -- attributing it to just this one row would be
   *  unproven, so the comparison must not trust it even when `qtyOrPieces` is present. */
  attributionUnique: boolean;
}

/** A stored RegulatedSalesLedger row, as this module needs it. */
export interface B681Row {
  id: string;
  entryType: "SALE" | "REVERSAL";
  qty: unknown;
  unitBasisQty: unknown;
  netSales: unknown;
  categoryTax: unknown;
  /** SA-609 (#2052): the ledger row's `createdAt` -- WHEN it was written, never `soldAt` (a back-datable
   *  business date). `classifySaleAxis` needs it to tell a box count from a never-boxed quantity on a
   *  snapshot-less line whose product is un-boxed now. REQUIRED so tsc flags every caller; `null` =
   *  unknown, read as pre-cutoff (reported, never corrected). */
  writtenAt: Date | string | null;
  /** Only for a REVERSAL row whose own `returnId` is set. */
  returnEvidence?: B681ReturnEvidence;
}

export type B681LineCategory =
  | "A" // box-axis SALE(s), consistent reversals (or none) -- axis-only correction
  | "A-piece-reversal" // a piece-axis (non-return) reversal, or a proven return-pieces mismatch
  | "straddles" // SALE rows split across BOTH axes on one line -- flagged, never auto-corrected
  | "clean" // every SALE row already on the pieces axis -- nothing to do
  | "unknown-basis"; // no usable evidence (product not boxed now, or SALE state unresolved) -- parked

export interface B681RowCorrection {
  rowId: string;
  /** Add this to the row's stored `qty`. 0 for every row except a return-pieces-mismatch
   *  reversal resolved by the single-SALE/single-reversal formula. */
  qtyDelta: number;
  /** Add this to the row's stored `unitBasisQty`. 0 when this row needs no axis correction. */
  unitBasisDelta: number;
  /** Add this to the row's stored `netSales`. 0 unless money was resolved for this row. */
  netDelta: number;
  /** Add this to the row's stored `categoryTax`. 0 unless money was resolved for this row. */
  taxDelta: number;
}

/** One return-driven reversal on a money-DECLINED line -- the CLI writes one
 *  `RegulatedLedgerParkedReversal` row per entry (SA-076 FIX 2). */
export interface B681ParkedReversal {
  reversalRowId: string;
  returnId: string;
  reason: string;
  /** The currently-booked share, `|unitBasisQty|` of the reversal row -- what the ledger currently
   *  claims was reversed, in pieces (matches `RegulatedLedgerParkedReversal.returnedPieces`). */
  bookedShare: number;
}

export interface B681LineCorrectionResult {
  category: B681LineCategory;
  packFactor: number | null;
  /** True only when this line's money was either proven correct (no return-driven reversal was
   *  wrong) or actively resolved by the single-SALE/single-reversal mismatch formula. */
  moneySafe: boolean;
  corrections: B681RowCorrection[];
  parkedReversals: B681ParkedReversal[];
  reason: string;
}

/** A REVERSAL row's own axis, read directly off its stored `qty`/`unitBasisQty` -- the fallback
 *  signal for a NON-return-driven reversal (credit-note or void), which does not have the
 *  over-close defect (see this file's header) and so is trusted by ratio alone, unchanged from
 *  this module's first version. */
function axisOfReversal(row: B681Row): "legacy" | "piece-axis" | "unknown" {
  const q = finiteOrNull(row.qty);
  const u = finiteOrNull(row.unitBasisQty);
  if (q == null || u == null) return "unknown";
  const aq = Math.abs(q);
  const au = Math.abs(u);
  if (aq < EPS) return "unknown";
  if (Math.abs(au - aq) < EPS) return "legacy";
  if (au > aq) return "piece-axis";
  return "unknown";
}

type MoneyStatus = "not-return-driven" | "evidence-unavailable" | "match" | "mismatch";

interface RevEval {
  row: B681Row;
  axis: "legacy" | "piece-axis" | "unknown";
  status: MoneyStatus;
  returnId: string | null;
  truePieces: number | null;
  bookedShare: number | null;
}

function evaluateReversal(row: B681Row, packFactor: number): RevEval {
  const axis = axisOfReversal(row);
  const ev = row.returnEvidence;
  if (ev === undefined) {
    return {
      row,
      axis,
      status: "not-return-driven",
      returnId: null,
      truePieces: null,
      bookedShare: null,
    };
  }
  const bookedShare =
    finiteOrNull(row.unitBasisQty) == null ? null : Math.abs(finiteOrNull(row.unitBasisQty)!);
  if (!ev.attributionUnique || ev.qtyOrPieces == null || bookedShare == null) {
    return {
      row,
      axis,
      status: "evidence-unavailable",
      returnId: ev.returnId,
      truePieces: null,
      bookedShare,
    };
  }
  const truePieces = ev.kind === "inline" ? ev.qtyOrPieces : round3(ev.qtyOrPieces * packFactor);
  const matches = Math.abs(truePieces - bookedShare) < EPS;
  return {
    row,
    axis,
    status: matches ? "match" : "mismatch",
    returnId: ev.returnId,
    truePieces,
    bookedShare,
  };
}

/**
 * `computeLineCorrection` -- see this file's header for the full design. `rows` is every
 * RegulatedSalesLedger row for ONE line key (`COALESCE(orderItemId, invoiceItemId)`), any order.
 * `priorCorrections` are this line's own already-applied B681 corrections (idempotency, same
 * convention as `classifySaleAxis`'s own `corrections` parameter -- pairing a row to its prior
 * corrections is the caller's job).
 */
export function computeLineCorrection(
  rows: B681Row[],
  line: SaleAxisLine | null,
  sourceLine: B681Line | null,
  productPackNow: number | null | undefined,
  priorCorrections: SaleAxisCorrection[] = [],
): B681LineCorrectionResult {
  const sales = rows.filter((r) => r.entryType === "SALE");
  const reversals = rows.filter((r) => r.entryType === "REVERSAL");
  const none = (
    reason: string,
    category: B681LineCategory = "clean",
  ): B681LineCorrectionResult => ({
    category,
    packFactor: null,
    moneySafe: false,
    corrections: [],
    parkedReversals: [],
    reason,
  });

  if (sales.length === 0) return none("no SALE rows on this line");

  const saleStates = sales.map((s) => ({
    row: s,
    result: classifySaleAxis(
      {
        entryType: "SALE",
        qty: s.qty,
        unitBasisQty: s.unitBasisQty,
        writtenAt: s.writtenAt ?? null,
      },
      line,
      priorCorrections,
      productPackNow,
    ),
  }));
  const firstUnknown = saleStates.find((s) => s.result.state === "unknown");
  if (firstUnknown) return none(firstUnknown.result.reason, "unknown-basis");

  const legacySaleCount = saleStates.filter((s) => s.result.state === "legacy").length;
  const pieceSaleCount = saleStates.filter((s) => s.result.state === "piece-axis").length;
  if (legacySaleCount > 0 && pieceSaleCount > 0) {
    return none(
      "SALE rows on this line are split across both axes -- not auto-corrected",
      "straddles",
    );
  }
  if (legacySaleCount === 0) return none("every SALE row is already on the pieces axis");

  const pack = deriveLinePack(
    { ...(line ?? {}), qty: sales[0].qty } as B681Line,
    sourceLine,
    productPackNow,
  );
  if ("unknown" in pack) return none(pack.reason, "unknown-basis");

  const revEvals = reversals.map((r) => evaluateReversal(r, pack.factor));
  const hasPieceAxisNonReturn = revEvals.some(
    (e) => e.status === "not-return-driven" && e.axis === "piece-axis",
  );
  const anyUnknownAxisNonReturn = revEvals.some(
    (e) => e.status === "not-return-driven" && e.axis === "unknown",
  );
  const anyMismatch = revEvals.some((e) => e.status === "mismatch");
  const anyEvidenceUnavailable = revEvals.some((e) => e.status === "evidence-unavailable");
  const singleShape = sales.length === 1 && reversals.length === 1;

  const category: B681LineCategory =
    hasPieceAxisNonReturn || anyMismatch ? "A-piece-reversal" : "A";

  // Axis-only baseline: qty*pack for the SALE row (never wrong there) and every reversal EXCEPT
  // one this module could not prove safe -- that row is either resolved by the money formula
  // below (mismatch, single-shape) or left untouched and parked (everything else).
  const axisDeltas = new Map<string, { unitBasisDelta: number; qtyDelta: number }>();
  for (const s of sales) {
    const qty = finiteOrNull(s.qty);
    if (qty == null) continue;
    const delta = round3(qty * pack.factor - (finiteOrNull(s.unitBasisQty) ?? 0));
    if (Math.abs(delta) >= EPS) axisDeltas.set(s.id, { unitBasisDelta: delta, qtyDelta: 0 });
  }
  for (const e of revEvals) {
    if (e.status === "mismatch" || e.status === "evidence-unavailable") continue;
    const qty = finiteOrNull(e.row.qty);
    if (qty == null) continue;
    const delta = round3(qty * pack.factor - (finiteOrNull(e.row.unitBasisQty) ?? 0));
    if (Math.abs(delta) >= EPS) axisDeltas.set(e.row.id, { unitBasisDelta: delta, qtyDelta: 0 });
  }

  let moneySafe = false;
  let moneyDeclined = false;
  const moneyDeltas = new Map<
    string,
    { unitBasisDelta: number; qtyDelta: number; netDelta: number; taxDelta: number }
  >();

  let declineCause = "";

  if (anyMismatch) {
    if (singleShape && !anyEvidenceUnavailable && !anyUnknownAxisNonReturn) {
      const rev = revEvals[0];
      const saleRow = sales[0];
      const saleQty = finiteOrNull(saleRow.qty) ?? 0;
      const saleNet = finiteOrNull(saleRow.netSales) ?? 0;
      const saleTax = finiteOrNull(saleRow.categoryTax) ?? 0;
      const soldPieces = saleQty * pack.factor;
      const truePieces = rev.truePieces ?? 0;
      const shareFrac = soldPieces === 0 ? 0 : clamp01(truePieces / soldPieces);
      const targetNet = roundMoney(-saleNet * shareFrac);
      const targetTax = roundMoney(-saleTax * shareFrac);
      const targetUnitBasis = -round3(truePieces);
      const targetQty = -round3(truePieces / pack.factor);
      const bookedNet = finiteOrNull(rev.row.netSales) ?? 0;
      const bookedTax = finiteOrNull(rev.row.categoryTax) ?? 0;
      const bookedUnitBasis = finiteOrNull(rev.row.unitBasisQty) ?? 0;
      const bookedQty = finiteOrNull(rev.row.qty) ?? 0;
      moneyDeltas.set(rev.row.id, {
        unitBasisDelta: round3(targetUnitBasis - bookedUnitBasis),
        qtyDelta: round3(targetQty - bookedQty),
        netDelta: roundMoney(targetNet - bookedNet),
        taxDelta: roundMoney(targetTax - bookedTax),
      });
      moneySafe = true;
    } else {
      moneyDeclined = true;
      declineCause = singleShape
        ? "the mismatched reversal's own evidence could not be trusted (unavailable/ambiguous, or an unknown-axis non-return reversal alongside it)"
        : "the line has more than one SALE row or reversal, so a return-pieces mismatch on it is not well-defined without a historical replay";
    }
  } else if (anyEvidenceUnavailable) {
    moneyDeclined = true;
    declineCause =
      "return evidence is unavailable or ambiguous for at least one reversal on this line";
  } else if (category === "A-piece-reversal") {
    // Only a non-return-driven piece-axis reversal can reach here (anyMismatch is false) --
    // the original narrow rule: exactly one SALE row, the line's full row history nets to zero
    // qty, no unknown-axis reversal alongside.
    const netQty = rows.reduce((sum, r) => sum + (finiteOrNull(r.qty) ?? 0), 0);
    moneySafe = sales.length === 1 && !anyUnknownAxisNonReturn && Math.abs(netQty) < EPS;
    if (moneySafe) {
      const saleRow = sales[0];
      const saleQty = finiteOrNull(saleRow.qty) ?? 0;
      const saleNet = finiteOrNull(saleRow.netSales) ?? 0;
      const saleTax = finiteOrNull(saleRow.categoryTax) ?? 0;
      for (const r of reversals) {
        const rQty = finiteOrNull(r.qty) ?? 0;
        const share = saleQty === 0 ? 0 : -rQty / saleQty;
        const targetNet = roundMoney(-saleNet * share);
        const targetTax = roundMoney(-saleTax * share);
        const netDelta = roundMoney(targetNet - (finiteOrNull(r.netSales) ?? 0));
        const taxDelta = roundMoney(targetTax - (finiteOrNull(r.categoryTax) ?? 0));
        if (Math.abs(netDelta) >= 0.005 || Math.abs(taxDelta) >= 0.005) {
          moneyDeltas.set(r.id, { unitBasisDelta: 0, qtyDelta: 0, netDelta, taxDelta });
        }
      }
    } else {
      moneyDeclined = true;
      declineCause =
        "this line is not a fully-closed single-SALE line (or an unknown-axis reversal sits alongside the piece-axis one)";
    }
  }
  // else: category "A", no mismatch, no unavailable evidence -- every return-driven reversal
  // present (if any) PROVABLY matches, and every non-return-driven one is axis-consistent. Money
  // was never in question; nothing declined.

  const parkedReversals: B681ParkedReversal[] = [];
  if (moneyDeclined) {
    for (const e of revEvals) {
      if (e.status === "not-return-driven") continue;
      // This ONE reversal's own evidence may be perfectly fine (`match`) even when the LINE's
      // money is declined for a different reason (a sibling reversal's mismatch, multiple SALE
      // rows, and so on) -- SA-076 FIX 2 parks every return-driven reversal on a declined line
      // regardless, so the reason must say WHY the line as a whole is unresolved, not claim this
      // row's own evidence is the problem when it demonstrably matched.
      const ownIssue =
        e.status === "mismatch"
          ? `this reversal's own booked share (${e.bookedShare}) does not match its return's true pieces (${e.truePieces})`
          : e.status === "evidence-unavailable"
            ? `this reversal's own return evidence is unavailable or ambiguous (no unique matching ReturnItem)`
            : `this reversal's own evidence matches (booked share ${e.bookedShare} = true pieces ${e.truePieces})`;
      parkedReversals.push({
        reversalRowId: e.row.id,
        returnId: e.returnId as string,
        reason: `B681: money uncorrected -- ${ownIssue}; the line overall is unresolved because ${declineCause}`,
        bookedShare: e.bookedShare ?? Math.abs(finiteOrNull(e.row.unitBasisQty) ?? 0),
      });
    }
  }

  // Additive merge, never overwrite: the mismatch-formula branch above sets moneyDeltas'
  // qty/unitBasis to the row's FULL target (axisDeltas has no entry for that row -- it was
  // excluded from the axis-only loop), while the redistribute branch sets moneyDeltas' qty/
  // unitBasis to 0 (that row's axis correction, if any, came entirely from axisDeltas). Either
  // way, summing the two maps per row is correct in both shapes.
  const byId = new Map<string, B681RowCorrection>();
  for (const [rowId, d] of axisDeltas) {
    byId.set(rowId, {
      rowId,
      qtyDelta: d.qtyDelta,
      unitBasisDelta: d.unitBasisDelta,
      netDelta: 0,
      taxDelta: 0,
    });
  }
  for (const [rowId, d] of moneyDeltas) {
    const existing = byId.get(rowId) ?? {
      rowId,
      qtyDelta: 0,
      unitBasisDelta: 0,
      netDelta: 0,
      taxDelta: 0,
    };
    const merged: B681RowCorrection = {
      rowId,
      qtyDelta: round3(existing.qtyDelta + d.qtyDelta),
      unitBasisDelta: round3(existing.unitBasisDelta + d.unitBasisDelta),
      netDelta: roundMoney(existing.netDelta + d.netDelta),
      taxDelta: roundMoney(existing.taxDelta + d.taxDelta),
    };
    if (
      Math.abs(merged.qtyDelta) < EPS &&
      Math.abs(merged.unitBasisDelta) < EPS &&
      Math.abs(merged.netDelta) < 0.005 &&
      Math.abs(merged.taxDelta) < 0.005
    ) {
      byId.delete(rowId);
    } else {
      byId.set(rowId, merged);
    }
  }

  const reason =
    category === "A"
      ? `box-axis SALE, consistent reversal(s) -- axis-only correction, pack ${pack.factor}`
      : anyMismatch && moneySafe
        ? `return pieces mismatch on a single-SALE/single-reversal line -- axis + money correction from the return's true pieces, pack ${pack.factor}`
        : moneyDeclined
          ? `box-axis SALE with a return/piece-axis reversal whose money could not be safely resolved -- axis-only correction, parked for architect/operator review, pack ${pack.factor}`
          : moneySafe
            ? `box-axis SALE with a piece-axis reversal on a fully-closed single-SALE line -- axis + money correction, pack ${pack.factor}`
            : `box-axis SALE with a piece-axis reversal -- axis-only correction, pack ${pack.factor}`;

  return {
    category,
    packFactor: pack.factor,
    moneySafe,
    corrections: [...byId.values()],
    parkedReversals,
    reason,
  };
}
