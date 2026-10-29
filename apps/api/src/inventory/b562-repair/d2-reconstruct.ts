import { MovementType, Prisma } from "@prisma/client";
import { costDecimal } from "../costing";
import { foldLedger, isReplayCorrection, type FoldRow } from "../fold-ledger";
import type { PlacedEvent } from "./d2-interpose";

/** The D1 anchor's reference prefix (b562-d1-ledger-gap-backfill.mjs). */
export const BACKFILL_PREFIX = "B562:BACKFILL:";
/** A D2 repair input's reference prefix: a fold INPUT (SA-372), one per product. */
export const REPAIR_PREFIX = "B562:REPAIR:";

export interface LedgerRow extends FoldRow {
  id: string;
  effectiveAt: Date;
  createdAt: Date;
}

export type Confidence = "EXACT" | "APPROX";
export interface Reconstruction {
  /** The true average AT the cutover, just after the D1 rows: the repair input's unitCost. Null = no cost history. */
  xC: Prisma.Decimal | null;
  /** The average now, folding every later row after a pin at X_c: what the live replay must land on. */
  xNow: Prisma.Decimal | null;
  /** D1's quantity − Σ interposed, folded at the cutover. */
  residual: Prisma.Decimal;
  stockAtCutover: Prisma.Decimal;
  confidence: Confidence;
  reasons: string[];
}

const accounting = (a: LedgerRow, b: LedgerRow) =>
  a.effectiveAt.getTime() - b.effectiveAt.getTime() ||
  a.createdAt.getTime() - b.createdAt.getTime() ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A row that moves the average when folded: what an uncertainty window must not contain for EXACT (SA-373 c). */
const isCostful = (r: LedgerRow) =>
  r.unitCost != null &&
  (r.type === MovementType.PURCHASE ||
    r.type === MovementType.ADJUSTMENT ||
    (r.type === MovementType.COST_BASIS && !isReplayCorrection(r)));

/**
 * Row 635 PR B (SA-136 §5 D2, SA-902 MUSTs 3 and 5): the product's true AVCO average, through THE fold (`foldLedger`).
 * Rows: the ledger minus the D1 anchor (`B562:BACKFILL:`) and minus any prior `B562:REPAIR:` input (RECOMPUTE rows the fold
 * skips itself), plus the interposed legacy sales, plus the residual (D1's quantity − Σ interposed) in the anchor's own
 * slot, so the stock at the cutover equals the live ledger's.
 * - X_c = the fold over every row dated at or before the cutover (the repair input sorts after them all: same effectiveAt,
 *   created later).
 * - X_now = the same fold continued past a pin at X_c, over every later row: what the live replay lands on once the input
 *   is in (the apply asserts it).
 * EXACT only when no residual, no live-pack line, no window across the cutover, and no costful row inside any event's
 * window (boundaries inclusive); otherwise APPROX with the reasons.
 */
export function reconstruct(input: {
  ledger: LedgerRow[];
  events: PlacedEvent[];
  approx: string[];
}): Reconstruction {
  const anchors = input.ledger.filter((r) => r.reference?.startsWith(BACKFILL_PREFIX));
  if (anchors.length !== 1)
    throw new Error(`reconstruct needs exactly one D1 anchor (got ${anchors.length})`);
  const anchor = anchors[0];
  const cut = anchor.effectiveAt;
  const base = input.ledger.filter(
    (r) => !r.reference?.startsWith(BACKFILL_PREFIX) && !r.reference?.startsWith(REPAIR_PREFIX),
  );
  const reasons = [...input.approx];

  let interposed = new Prisma.Decimal(0);
  const virtual: LedgerRow[] = input.events.map((e, i) => {
    interposed = interposed.add(e.qty);
    return {
      id: `~d2:${String(i).padStart(6, "0")}:${e.orderId}`,
      type: MovementType.SALE,
      quantity: e.qty,
      unitCost: null,
      reference: `D2:${e.kind}:${e.orderId}`,
      effectiveAt: e.at,
      createdAt: e.at,
    };
  });
  const residual = new Prisma.Decimal(anchor.quantity).sub(interposed);
  if (!residual.isZero())
    reasons.push(`residual ${residual.toString()} pieces folded at the cutover`);
  // The residual takes the anchor's exact slot (its id, effectiveAt and createdAt).
  const residualRow: LedgerRow = { ...anchor, quantity: residual, reference: "D2:RESIDUAL" };

  for (const e of input.events) {
    const [a, b] = e.window;
    for (const r of base) {
      if (isCostful(r) && r.effectiveAt >= a && r.effectiveAt <= b) {
        reasons.push(
          e.unrecorded
            ? `order ${e.orderId}: its stock may have moved any time from created to last updated (costful row ${r.id})`
            : `costful row ${r.id} inside order ${e.orderId}'s ${e.kind} window`,
        );
      }
    }
  }

  const rows = [...base, ...virtual, residualRow].sort(accounting);
  const upTo = rows.filter((r) => r.effectiveAt <= cut);
  const after = rows.filter((r) => r.effectiveAt > cut);
  const atCut = foldLedger(upTo, { isStandard: false, averageCost: null });
  const xC = atCut.avg != null ? costDecimal(atCut.avg) : null;
  let xNow: Prisma.Decimal | null = null;
  if (xC != null) {
    const pin: FoldRow = {
      type: MovementType.COST_BASIS,
      quantity: 0,
      unitCost: xC,
      reference: `${REPAIR_PREFIX}reconstruction`,
    };
    const now = foldLedger([...upTo, pin, ...after], { isStandard: false, averageCost: null });
    xNow = now.avg != null ? costDecimal(now.avg) : null;
  }
  return {
    xC,
    xNow,
    residual,
    stockAtCutover: atCut.stock,
    confidence: reasons.length === 0 ? "EXACT" : "APPROX",
    reasons: [...new Set(reasons)], // SA-923 LOW: one line per reason, not one per event
  };
}
