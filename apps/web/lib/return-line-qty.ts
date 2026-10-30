import { invoiceLineQtyText } from "@routeflow/pricing";

/** The slice of an order line (or the wire's `line`) the words come from: its own snapshot, never the live product. */
export interface ReturnLineQtyInput {
  qty: number | string;
  boxes?: number | null;
  pieces?: number | null;
  unitLabel?: string | null;
}

/**
 * SA-1042 B9a: what a return line counts, in pieces with the line's own unit beside it: "400 pcs (2 Cases)",
 * "100 pcs (10 boxes)", "25 pcs (2 boxes + 5 pcs)" or just "12 pcs". A line with no stored split is plain pieces
 * (a factor-1 unit line included), so there is nothing to put in the brackets. The unit words come from the line's
 * snapshot through `invoiceLineQtyText`.
 */
export function returnLineQtyText(line: ReturnLineQtyInput): string {
  const pcs = Number(line.qty);
  const pieces = Number.isFinite(pcs) ? String(parseFloat(pcs.toFixed(3))) : String(line.qty);
  if (line.boxes == null && line.pieces == null) return `${pieces} pcs`;
  return `${pieces} pcs (${invoiceLineQtyText(line)})`;
}
