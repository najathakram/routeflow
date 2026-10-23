import { MovementType, Prisma } from "@prisma/client";
import { costDecimal, nextAverageCost, reverseAverageCost } from "./costing";

/** B562 PR-3 (SA-136 §4): the reference prefix of a replay's own COST_BASIS correction. */
export const REPLAY_CORRECTION_PREFIX = "RECOMPUTE:";
/**
 * A replay correction is the fold's OUTPUT, never an input (see foldLedger). SA-372: all three
 * marks are required — a COST_BASIS row, quantity 0, and the `RECOMPUTE:` reference — so a manual
 * or `B562:REPAIR:` cost-basis row (or any other movement) can never be skipped as one.
 */
export const isReplayCorrection = (m: {
  type: string;
  quantity: Prisma.Decimal | number | string;
  reference: string | null | undefined;
}) =>
  m.type === MovementType.COST_BASIS &&
  new Prisma.Decimal(m.quantity).isZero() &&
  (m.reference?.startsWith(REPLAY_CORRECTION_PREFIX) ?? false);

/** One ledger row as the fold reads it. */
export interface FoldRow {
  type: string;
  quantity: Prisma.Decimal | number | string;
  unitCost: Prisma.Decimal | number | string | null;
  reference: string | null;
}

/**
 * B562 PR-3 (SA-136 §4), extracted by row 635 (SA-902 MUST 3): THE cost fold, the only one. Rows must already be in
 * accounting order (effectiveAt, createdAt, id). A running (stock, avg):
 * - COST_BASIS (a manual/owner cost basis, a `B562:REPAIR:` input) ⇒ avg := unitCost; a replay's own `RECOMPUTE:` row
 *   is skipped (isReplayCorrection)
 * - PURCHASE with unitCost ⇒ weighted average update (a negative bill-revert row reverses it)
 * - ADJUSTMENT with unitCost ⇒ weighted forward (qty>0) / exact reverse (qty<0)
 * - everything else (SALE / RETURN / WRITE_OFF / quantity-only) ⇒ quantity only
 * STANDARD products carry `averageCost` frozen: quantities only (the live recordPurchase never moves it).
 * `replayProduct` and the D2 average repair both call this; the parity spec pins them equal.
 */
export function foldLedger(
  rows: Iterable<FoldRow>,
  opts: { isStandard: boolean; averageCost: Prisma.Decimal | number | string | null },
): { stock: Prisma.Decimal; avg: Prisma.Decimal | null; hasCostfulHistory: boolean } {
  const { isStandard } = opts;
  let stock = new Prisma.Decimal(0);
  let avg: Prisma.Decimal | null =
    isStandard && opts.averageCost != null ? costDecimal(opts.averageCost) : null;
  let hasCostfulHistory = isStandard && avg != null;

  for (const m of rows) {
    const qty = new Prisma.Decimal(m.quantity);
    const unitCost = m.unitCost != null ? new Prisma.Decimal(m.unitCost) : null;

    if (!isStandard) {
      switch (m.type) {
        case MovementType.COST_BASIS:
          if (unitCost != null && !isReplayCorrection(m)) {
            avg = costDecimal(unitCost);
            hasCostfulHistory = true;
          }
          break;
        case MovementType.PURCHASE:
          if (unitCost != null) {
            if (qty.lt(0)) {
              // B846: a bill-revert row is the exact inverse of its receipt — reverse the average
              // (kept when the reversal empties stock), never feed a negative qty to nextAverageCost
              // (stock + qty = 0 divides by zero).
              if (avg != null) {
                avg = reverseAverageCost(stock, avg, qty.neg(), unitCost) ?? avg;
                hasCostfulHistory = true;
              }
            } else {
              avg = nextAverageCost(stock, avg, qty, unitCost);
              hasCostfulHistory = true;
            }
          }
          break;
        case MovementType.ADJUSTMENT:
          // Costed adjustments are bill-void compensations: reverse the average
          if (unitCost != null && avg != null) {
            if (qty.gt(0)) avg = nextAverageCost(stock, avg, qty, unitCost);
            else if (qty.lt(0)) avg = reverseAverageCost(stock, avg, qty.neg(), unitCost) ?? avg;
          }
          break;
        default:
          // SALE / RETURN / WRITE_OFF: quantity only, average carries forward
          break;
      }
    }

    stock = stock.add(qty);
  }
  return { stock, avg, hasCostfulHistory };
}
