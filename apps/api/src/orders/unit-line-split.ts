import { ConflictException } from "@nestjs/common";
import * as Sentry from "@sentry/node";

/**
 * #2230 / SA-388d: the one shape a unit line may never be written in — B718's over-bill shape.
 *
 * A line sold by a named unit (`unitLabel` set) whose pack factor is > 1 and whose `qty` is > 0 must
 * carry a split the count can be read from: `boxes >= 1` or `pieces >= 1`. A part-unit split
 * (0 boxes + 5 pieces, a broken Case at the door) is VALID (SA-178), and an "Each" line (factor 1)
 * stores no split at all — both pass. The ALL-EMPTY split (boxes and pieces null or 0) is refused:
 * its count is underivable, and a reader that falls back to qty-as-boxes bills it 12x.
 *
 * The same predicate is the DB CHECK `OrderItem_unitLine_split_chk` / `InvoiceItem_unitLine_split_chk`
 * (migration 20260926180000_b2230_unit_line_split_check_not_valid); this assertion fails the writer
 * with a named error before the database has to.
 */
export interface UnitLineSplitShape {
  unitLabel?: string | null;
  unitsPerBox?: number | string | { toString(): string } | null;
  qty?: number | string | { toString(): string } | null;
  boxes?: number | null;
  pieces?: number | null;
  /** Naming and ids only, read when present: never tenant data. */
  id?: string | null;
  orderItemId?: string | null;
  invoiceItemId?: string | null;
  productId?: string | null;
  description?: string | null;
  name?: string | null;
}

const n = (v: unknown, fallback: number): number => (v == null ? fallback : Number(v));

/** True for the refused shape: unit line, factor > 1, qty > 0, neither boxes >= 1 nor pieces >= 1. */
export function isEmptyUnitLineSplit(line: UnitLineSplitShape): boolean {
  return (
    line.unitLabel != null &&
    n(line.unitsPerBox, 1) > 1 &&
    n(line.qty, 0) > 0 &&
    n(line.boxes, 0) < 1 &&
    n(line.pieces, 0) < 1
  );
}

export const UNIT_LINE_SPLIT_MISSING = "UNIT_LINE_SPLIT_MISSING";

/** The line ids a shape carries (`id`, `orderItemId`, `invoiceItemId`), for the Sentry report only. */
export function unitLineIds(line: UnitLineSplitShape): string[] {
  const ids = [line.id, line.orderItemId, line.invoiceItemId].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return [...new Set(ids)];
}

/**
 * SA-388g: a 409 the operator can act on, never a 500 — the line needs a support repair before it can
 * be invoiced. Named by the line's own description / name / product id.
 */
export class UnitLineSplitError extends ConflictException {
  constructor(where: string, line: UnitLineSplitShape) {
    const what = line.description || line.name || line.productId || "This line";
    super({
      code: UNIT_LINE_SPLIT_MISSING,
      message:
        `${what} is sold by the ${line.unitLabel} but its Case/Each split is missing — ask support ` +
        "to repair this line before invoicing",
    });
    this.name = "UnitLineSplitError";
  }
}

/**
 * Throw before a writer stores the refused shape. Returns the line so it can wrap a return value.
 * A 409 never reaches the global Sentry filter (it reports only 5xx), so the guard reports it itself,
 * FIRST, with the line ids and the writer name only (no tenant data).
 */
export function assertUnitLineSplit<T extends UnitLineSplitShape>(line: T, where: string): T {
  if (isEmptyUnitLineSplit(line)) {
    Sentry.captureMessage(`${UNIT_LINE_SPLIT_MISSING} at ${where}`, {
      level: "error",
      extra: { where, lineIds: unitLineIds(line) },
    });
    throw new UnitLineSplitError(where, line);
  }
  return line;
}
