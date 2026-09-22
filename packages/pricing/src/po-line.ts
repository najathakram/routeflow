import { roundMoney, roundUnitCost } from "./pricing";

/**
 * Purchase-order line money: ONE builder that the API (create/update) and the web/mobile forms all import.
 *
 * A line is entered in one of two denominations, and `packSize` is the marker (Senior Architect ruling
 * 2026-09-22, no migration): a NON-NULL `packSize` means the cost was entered PER CASE of that size; null means
 * per piece. For a case line the document total is computed from the ENTERED figures,
 *   totalCost = roundMoney(caseCost x (cases + loosePieces / packSize)),
 * and stored exactly. The per-piece `unitCost` (caseCost / packSize at 4 dp) exists for COSTING only (stock lots,
 * average cost) and is NEVER multiplied back up into a document total: 12 pieces at 0.9167 is 11.0004, and
 * 1,000 cases of that is $11,000.40, not the $11,000.00 that was typed. For a per-piece line the total is
 * roundMoney(qtyOrdered x unitCost).
 */

export interface POCaseLineInput {
  /** Pieces per case (integer > 1): the denomination the cost was entered in. */
  packSize: number;
  /** Cost per CASE as entered. */
  caseCost: number;
  /** Whole cases ordered. */
  cases: number;
  /** Loose pieces beyond whole cases (rolled into cases at packSize). */
  loosePieces?: number;
}

export interface POPieceLineInput {
  /** Pieces ordered (3 dp, Decimal(10,3)). */
  qtyOrdered: number;
  /** Cost per PIECE (4 dp, Decimal(10,4)). */
  unitCost: number;
}

export interface POLineAmounts {
  /** Pieces ordered, exact for a case line (cases x packSize + loose). */
  qtyOrdered: number;
  /** Per-piece cost at 4 dp, for costing only. */
  unitCost: number;
  /** The exact line total for the document (2 dp). */
  totalCost: number;
  /** Non-null = the cost was entered per case of this size. */
  packSize: number | null;
  /** The case cost as entered (null for a per-piece line). */
  caseCost: number | null;
}

const isCaseInput = (i: POCaseLineInput | POPieceLineInput): i is POCaseLineInput =>
  (i as POCaseLineInput).caseCost !== undefined;

const wholeNonNegative = (n: unknown) => Number.isFinite(Number(n)) && Number(n) >= 0;

/** `Decimal(10,3)` quantity precision. */
const round3 = (n: number) => Math.round(Number((n * 1000).toFixed(4))) / 1000;

/** Builds the stored amounts of one PO line. Throws RangeError on an input no valid line can have. */
export function buildPOLine(input: POCaseLineInput | POPieceLineInput): POLineAmounts {
  if (isCaseInput(input)) {
    const pack = Number(input.packSize);
    if (!Number.isInteger(pack) || pack <= 1) {
      throw new RangeError(`a case line needs a whole packSize above 1, got ${input.packSize}`);
    }
    const caseCost = Number(input.caseCost);
    if (!Number.isFinite(caseCost) || caseCost < 0) {
      throw new RangeError(`caseCost must be a non-negative number, got ${input.caseCost}`);
    }
    const cases = Number(input.cases);
    const loose = Number(input.loosePieces ?? 0);
    if (!wholeNonNegative(cases) || !Number.isInteger(cases)) {
      throw new RangeError(`cases must be a whole number, got ${input.cases}`);
    }
    if (!wholeNonNegative(loose) || !Number.isInteger(loose)) {
      throw new RangeError(`loosePieces must be a whole number, got ${input.loosePieces}`);
    }
    const qtyOrdered = cases * pack + loose;
    return {
      qtyOrdered,
      unitCost: roundUnitCost(caseCost / pack),
      // caseCost x (cases + loose / pack) evaluated as (caseCost x pieces) / pack: one rounding, at the end
      totalCost: roundMoney((caseCost * qtyOrdered) / pack),
      packSize: pack,
      caseCost,
    };
  }
  const qtyOrdered = round3(Number(input.qtyOrdered));
  const unitCost = Number(input.unitCost);
  if (!Number.isFinite(qtyOrdered) || qtyOrdered < 0) {
    throw new RangeError(`qtyOrdered must be a non-negative number, got ${input.qtyOrdered}`);
  }
  if (!Number.isFinite(unitCost) || unitCost < 0) {
    throw new RangeError(`unitCost must be a non-negative number, got ${input.unitCost}`);
  }
  return {
    qtyOrdered,
    unitCost,
    totalCost: roundMoney(qtyOrdered * unitCost),
    packSize: null,
    caseCost: null,
  };
}

/**
 * The case cost an operator sees for a STORED line. When the line's exact `totalCost` and `qtyOrdered` are known
 * it is derived FROM THE TOTAL: `totalCost x packSize / qtyOrdered` (a new exact row, 1,000 cases stored at
 * $11,000.00, reads back 11 whatever its 4 dp per-piece cost is). Without them (no stored total) it falls back to
 * `unitCost x packSize` at 4 dp. An OLD drifted row (0.9167 a piece, total 11,000.40) reads back 11.0004: shown
 * honestly, never masked, so the operator re-enters 11.00. Existing rows are read as stored and never rewritten.
 */
export function derivedCaseCost(
  unitCost: number,
  packSize: number,
  exact?: { totalCost?: number | null; qtyOrdered?: number | null },
): number {
  const pack = Number(packSize);
  if (!Number.isInteger(pack) || pack <= 1) return roundUnitCost(Number(unitCost) || 0);
  const total = Number(exact?.totalCost);
  const qty = Number(exact?.qtyOrdered);
  if (exact?.totalCost != null && Number.isFinite(total) && total > 0 && qty > 0) {
    return roundUnitCost((total * pack) / qty);
  }
  return roundUnitCost((Number(unitCost) || 0) * pack);
}
