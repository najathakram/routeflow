/**
 * B681 correction routine's money-critical core (Senior Architect ruling 2026-09-22, SA-058
 * through SA-073). Pure functions only -- no DB, no `new Date()`, no I/O. The CLI
 * (`apps/api/scripts/b681-correct-ledger.mjs`) is a thin DB-facing wrapper around this: it reads
 * rows, calls these, and writes exactly the corrections they return.
 *
 * TWO jobs, kept separate because their risk is different:
 *
 *   1. `deriveLinePack` -- the SAME pairing pattern as `apps/api/src/common/line-pack-factors.ts`'s
 *      `resolvePackFactors` (SA-069b: copy verbatim, this comment names that file as the source of
 *      truth), scoped to ONE line instead of a batch. Never multiplies by a live product's pack
 *      directly -- derives a WHOLE-NUMBER factor from the ONE live sibling InvoiceItem's own
 *      split, via `legacyLinePieces`. `unknown` -> the line PARKS, never guessed.
 *
 *   2. `computeLineCorrection` -- given a line's FULL row history (every SALE + REVERSAL on this
 *      line key, `classifySaleAxis` already run per SALE row) and its derived pack, decides what
 *      (if anything) needs correcting.
 *
 * AXIS: `qty` (the line's own unit -- boxes, or whatever `unitLabel` names) is NEVER wrong on any
 * stored row -- B671/#1221 fixed the one write path that could misread it, and every row written
 * before that fix still stored `qty` correctly (the defect was always in `unitBasisQty`, never
 * `qty`). So the `unitBasisQty` correction for EVERY row -- SALE and REVERSAL alike -- is
 * uniformly `qty * pack`, signed the same as the row's own `qty`. This needs no replay of the
 * write-time booking algorithm's "remaining"/"frac" state at all: it is a straight re-expression
 * of every row on the correct axis, using the ONE pack this line's evidence already proves.
 *
 * MONEY is a different story. `netSales`/`categoryTax` on a SALE row are the line's own
 * post-discount subtotal/tax -- never axis-dependent, so a SALE row's money is ALREADY correct
 * and is never corrected here. A REVERSAL row's money CAN be wrong:
 * `regulated-ledger.service.ts` books a partial reversal's net/tax via `frac = rNative /
 * saleNativeAxis`, and for a PIECES-native reversal (the live write path since B671/#1221) that
 * denominator was the SALE's own (possibly box-axis-wrong) `unitBasisQty` -- an inflated frac
 * over-reverses money. A CLOSING reversal self-corrects (it books the line's exact remaining
 * balance, not a frac), so only a NON-closing reversal against a box-axis SALE can have wrong
 * money -- and nothing stored on the rows says, in general, which historical reversal closed its
 * line at the moment it was written.
 *
 * So money correction here is scoped to the ONE shape it can prove safe without replaying any
 * historical "remaining" state: exactly one SALE row, and the line's full row history nets to
 * zero qty (fully reversed, nothing left outstanding). There, since `qty` was always correct,
 * each reversal's TRUE share of the sale is exactly `-qty(reversal) / qty(sale)` (pack cancels out
 * of this ratio entirely -- it is the same fraction on either axis), and those shares sum to
 * exactly 1 by construction of "fully reversed". Redistributing the SALE's own (correct) net/tax
 * by that share gives the target; the delta is `target - booked`. Any other shape -- more than one
 * SALE row on the line, or qty still outstanding -- is left `moneySafe: false`: the axis is still
 * corrected, but net/tax are reported for an architect-reviewed follow-up rather than guessed.
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

/** A stored RegulatedSalesLedger row, as this module needs it. */
export interface B681Row {
  id: string;
  entryType: "SALE" | "REVERSAL";
  qty: unknown;
  unitBasisQty: unknown;
  netSales: unknown;
  categoryTax: unknown;
}

export type B681LineCategory =
  | "A" // box-axis SALE(s), consistent (box-axis) reversals -- axis-only correction
  | "A-piece-reversal" // box-axis SALE(s) + a piece-axis reversal -- axis correction, money too when moneySafe
  | "straddles" // SALE rows split across BOTH axes on one line -- flagged, never auto-corrected
  | "clean" // every SALE row already on the pieces axis -- nothing to do
  | "unknown-basis"; // no usable evidence (product not boxed now, or SALE state unresolved) -- parked

export interface B681RowCorrection {
  rowId: string;
  /** Add this to the row's stored `unitBasisQty`. 0 when this row needs no axis correction. */
  unitBasisDelta: number;
  /** Add this to the row's stored `netSales`. 0 unless `moneySafe`. */
  netDelta: number;
  /** Add this to the row's stored `categoryTax`. 0 unless `moneySafe`. */
  taxDelta: number;
}

export interface B681LineCorrectionResult {
  category: B681LineCategory;
  packFactor: number | null;
  /** True only for a fully-reversed, single-SALE-row line where net/tax deltas are well-defined
   *  without replaying historical write-time state -- see this file's header. */
  moneySafe: boolean;
  corrections: B681RowCorrection[];
  reason: string;
}

/** A REVERSAL row's own axis, read directly off its stored `qty`/`unitBasisQty` -- unlike a SALE
 *  row, a REVERSAL needs no line-shape evidence: it is just the ratio of what it already booked. */
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

/**
 * `computeLineCorrection` -- see this file's header for the full design. `rows` is every
 * RegulatedSalesLedger row for ONE line key (`COALESCE(orderItemId, invoiceItemId)`), any order.
 * `priorCorrections` are this line's own already-applied B681 corrections (idempotency, same
 * convention as `classifySaleAxis`'s own `corrections` parameter -- pairing a row to its prior
 * corrections is the caller's job).
 */
export function computeLineCorrection(
  rows: B681Row[],
  // Only the shape classifySaleAxis needs -- qty is never read off `line` itself here; the pack
  // derivation below builds its own B681Line by pairing this shape with sales[0]'s own qty.
  line: SaleAxisLine | null,
  sourceLine: B681Line | null,
  productPackNow: number | null | undefined,
  priorCorrections: SaleAxisCorrection[] = [],
): B681LineCorrectionResult {
  const sales = rows.filter((r) => r.entryType === "SALE");
  const reversals = rows.filter((r) => r.entryType === "REVERSAL");

  if (sales.length === 0) {
    return {
      category: "clean",
      packFactor: null,
      moneySafe: false,
      corrections: [],
      reason: "no SALE rows on this line",
    };
  }

  const saleStates = sales.map((s) => ({
    row: s,
    result: classifySaleAxis(
      { entryType: "SALE", qty: s.qty, unitBasisQty: s.unitBasisQty },
      line,
      priorCorrections,
      productPackNow,
    ),
  }));

  const firstUnknown = saleStates.find((s) => s.result.state === "unknown");
  if (firstUnknown) {
    return {
      category: "unknown-basis",
      packFactor: null,
      moneySafe: false,
      corrections: [],
      reason: firstUnknown.result.reason,
    };
  }

  const legacySaleCount = saleStates.filter((s) => s.result.state === "legacy").length;
  const pieceSaleCount = saleStates.filter((s) => s.result.state === "piece-axis").length;

  if (legacySaleCount > 0 && pieceSaleCount > 0) {
    return {
      category: "straddles",
      packFactor: null,
      moneySafe: false,
      corrections: [],
      reason: "SALE rows on this line are split across both axes -- not auto-corrected",
    };
  }

  if (legacySaleCount === 0) {
    return {
      category: "clean",
      packFactor: null,
      moneySafe: false,
      corrections: [],
      reason: "every SALE row is already on the pieces axis",
    };
  }

  // legacySaleCount > 0, pieceSaleCount === 0: every SALE row is box-axis. One pack for the whole line.
  const pack = deriveLinePack(
    { ...(line ?? {}), qty: sales[0].qty } as B681Line,
    sourceLine,
    productPackNow,
  );
  if ("unknown" in pack) {
    return {
      category: "unknown-basis",
      packFactor: null,
      moneySafe: false,
      corrections: [],
      reason: pack.reason,
    };
  }

  const revStates = reversals.map((r) => ({ row: r, axis: axisOfReversal(r) }));
  const anyUnknownRev = revStates.some((r) => r.axis === "unknown");
  const revPieceCount = revStates.filter((r) => r.axis === "piece-axis").length;
  const category: B681LineCategory = revPieceCount > 0 ? "A-piece-reversal" : "A";

  const axisDeltas = new Map<string, number>();
  for (const r of rows) {
    const qty = finiteOrNull(r.qty);
    if (qty == null) continue;
    const targetUnitBasis = round3(qty * pack.factor);
    const booked = finiteOrNull(r.unitBasisQty) ?? 0;
    const delta = round3(targetUnitBasis - booked);
    if (Math.abs(delta) >= EPS) axisDeltas.set(r.id, delta);
  }

  const netQty = rows.reduce((sum, r) => sum + (finiteOrNull(r.qty) ?? 0), 0);
  const moneySafe =
    category === "A-piece-reversal" &&
    sales.length === 1 &&
    !anyUnknownRev &&
    Math.abs(netQty) < EPS;

  const moneyDeltas = new Map<string, { netDelta: number; taxDelta: number }>();
  if (moneySafe) {
    const saleRow = sales[0];
    const saleQty = finiteOrNull(saleRow.qty) ?? 0;
    const saleNet = finiteOrNull(saleRow.netSales) ?? 0;
    const saleTax = finiteOrNull(saleRow.categoryTax) ?? 0;
    for (const r of reversals) {
      const rQty = finiteOrNull(r.qty) ?? 0;
      const share = saleQty === 0 ? 0 : -rQty / saleQty; // qty was always correct -- pack cancels out
      const targetNet = roundMoney(-saleNet * share);
      const targetTax = roundMoney(-saleTax * share);
      const netDelta = roundMoney(targetNet - (finiteOrNull(r.netSales) ?? 0));
      const taxDelta = roundMoney(targetTax - (finiteOrNull(r.categoryTax) ?? 0));
      if (Math.abs(netDelta) >= 0.005 || Math.abs(taxDelta) >= 0.005) {
        moneyDeltas.set(r.id, { netDelta, taxDelta });
      }
    }
  }

  const byId = new Map<string, B681RowCorrection>();
  for (const [rowId, unitBasisDelta] of axisDeltas) {
    byId.set(rowId, { rowId, unitBasisDelta, netDelta: 0, taxDelta: 0 });
  }
  for (const [rowId, m] of moneyDeltas) {
    const existing = byId.get(rowId) ?? { rowId, unitBasisDelta: 0, netDelta: 0, taxDelta: 0 };
    existing.netDelta = m.netDelta;
    existing.taxDelta = m.taxDelta;
    byId.set(rowId, existing);
  }

  return {
    category,
    packFactor: pack.factor,
    moneySafe,
    corrections: [...byId.values()],
    reason:
      category === "A"
        ? `box-axis SALE, consistent box-axis reversal(s) -- axis-only correction, pack ${pack.factor}`
        : moneySafe
          ? `box-axis SALE with a piece-axis reversal on a fully-closed line -- axis + money correction, pack ${pack.factor}`
          : `box-axis SALE with a piece-axis reversal on a line not provably fully-closed by a single SALE row -- axis-only correction, money left for architect review, pack ${pack.factor}`,
  };
}
