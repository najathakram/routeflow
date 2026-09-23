import { formatQtySplit } from "@routeflow/pricing";

/**
 * B653: the operator invoice detail's per-line qty/unit text (`(operator)/(tabs)/invoices/[id].tsx`).
 * Pure and testable for the same reason `order-line-display.ts`'s helpers are — RN cannot import a
 * web component to assert against, so the display decision lives in its own file.
 *
 * The screen used to call `formatQtySplit({qty, boxes, pieces})` with no `boxLabel`, so a units_v1
 * line (sold by its own unit, e.g. "Case", not loose pieces) read "3 boxes" — and the price suffix
 * separately hardcoded "/box", so the same line ALSO read "$220.00/box" beside a per-Case price.
 * Both read off the line's own `unitLabel` now; an ordinary boxed line (no `unitLabel`) is
 * byte-identical to before (`formatQtySplit` already defaults to "box"/"boxes" on a null boxLabel,
 * and `invoiceLineUnitNoun` defaults to "box" the same way).
 */
export interface InvoiceLineQtyLike {
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitLabel?: string | null;
}

/** "3 Cases" / "2 boxes + 3 pcs" / "27" — mirrors the PDF's `qtyCellText`. */
export function invoiceLineQtyText(item: InvoiceLineQtyLike): string {
  const boxLabel = item.unitLabel?.trim() || null;
  return formatQtySplit({ qty: item.qty, boxes: item.boxes, pieces: item.pieces, boxLabel });
}

/** The box-level noun for the "@ price/<noun>" suffix — "Case" for a units_v1 line, "box" default. */
export function invoiceLineUnitNoun(item: { unitLabel?: string | null }): string {
  return item.unitLabel?.trim() || "box";
}
