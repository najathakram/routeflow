import { invoiceLineQtyText } from "@routeflow/pricing";

/** The slice of an order line (or the wire's `line`) the words come from: its own snapshot, never the live product. */
export interface ReturnLineQtyInput {
  qty: number | string;
  boxes?: number | null;
  pieces?: number | null;
  unitLabel?: string | null;
}

/**
 * SA-1042 B9a: a split count, in pieces with the line's own unit beside it: "400 pcs (2 Cases)", "100 pcs (10 boxes)",
 * "25 pcs (2 boxes + 5 pcs)". With no split it is a pooled item, plain pieces. A line goes through `lineCountText`,
 * which picks the text by the line's mode. The unit words come from the line's snapshot through `invoiceLineQtyText`.
 */
export function returnLineQtyText(line: ReturnLineQtyInput): string {
  const pcs = Number(line.qty);
  const pieces = Number.isFinite(pcs) ? String(parseFloat(pcs.toFixed(3))) : String(line.qty);
  if (line.boxes == null && line.pieces == null) return `${pieces} pcs`;
  const words = invoiceLineQtyText(line);
  return words === `${pieces} pcs` ? words : `${pieces} pcs (${words})`;
}

// ─── B9c: counting a return by line, and reading it back ───────────────────────────────────────────────────────────────

/** An order line as the form and the detail page hold it: its own snapshot, never the live product. */
export interface ReturnLineSnapshot {
  qty: number | string;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
}

/**
 * How a line is counted (the same rule the server applies): `split` = the line stores boxes/pieces (two steppers, in the
 * line's unit and pcs); `unit` = a factor-1 unit line (label, snapshot 1, no split: one stepper with its word); `legacy` =
 * a box-unaware line, one input in the line's own unit sent as `qty`.
 */
export type LineCountMode = "split" | "unit" | "legacy";
export function lineCountMode(line: ReturnLineSnapshot): LineCountMode {
  if (line.boxes != null || line.pieces != null) return "split";
  if ((line.unitLabel ?? "").trim() !== "" && Number(line.unitsPerBox ?? 0) === 1) return "unit";
  return "legacy";
}

/** The line's unit words ("Case" / "Cases", else "box" / "boxes"), taken through `invoiceLineQtyText`'s own word rules. */
export function lineUnitWords(line: ReturnLineSnapshot): { one: string; many: string } {
  const word = (n: number) =>
    invoiceLineQtyText({ qty: n, boxes: n, pieces: 0, unitLabel: line.unitLabel })
      .replace(/^\d+\s/, "")
      .trim();
  return { one: word(1), many: word(2) };
}

/** What the person typed for one row. */
export interface LineCountInput {
  boxes: string;
  pieces: string;
  qty: string;
}

const num = (v: string): number => (v.trim() === "" ? 0 : Number(v));

/** The payload fields for a row, in the line's own unit, or null when nothing is being returned. */
export function lineCountFields(
  line: ReturnLineSnapshot,
  v: LineCountInput,
): { boxes: number; pieces: number } | { qty: number } | null {
  const mode = lineCountMode(line);
  if (mode === "legacy") return num(v.qty) > 0 ? { qty: num(v.qty) } : null;
  const boxes = num(v.boxes);
  const pieces = mode === "split" ? num(v.pieces) : 0;
  return boxes > 0 || pieces > 0 ? { boxes, pieces } : null;
}

/** A message for a count that cannot be right. The server decides; this only saves the trip. */
export function lineCountProblem(line: ReturnLineSnapshot, v: LineCountInput): string | null {
  const mode = lineCountMode(line);
  if (mode === "legacy") {
    // A box-unaware line can hold a fraction, and the server takes one.
    const n = Number(v.qty);
    if (v.qty.trim() !== "" && !(Number.isFinite(n) && n > 0)) return "Enter a number above 0.";
  } else {
    const parts = mode === "unit" ? [v.boxes] : [v.boxes, v.pieces];
    if (parts.some((p) => p.trim() !== "" && !(Number.isInteger(Number(p)) && Number(p) >= 0)))
      return "Use whole numbers.";
  }
  const f = lineCountFields(line, v);
  if (!f) return null;
  const ordered = Number(line.qty);
  const per = mode === "split" ? Number(line.unitsPerBox ?? 0) : 1;
  const count = "qty" in f ? f.qty : f.boxes * (per > 0 ? per : 1) + f.pieces;
  return count > ordered ? `Cannot exceed what was ordered (${orderedItemQtyText(line)}).` : null;
}

/** A split line's quantity in the line's own boxes and pieces, from its pieces. */
function splitOf(pieces: number, line: ReturnLineSnapshot): ReturnLineQtyInput {
  const per = Number(line.unitsPerBox ?? 0);
  if (!(per > 0)) return { qty: pieces };
  return {
    qty: pieces,
    boxes: Math.floor(pieces / per),
    pieces: pieces % per,
    unitLabel: line.unitLabel,
  };
}

/**
 * SA-1042 A-8: a count on a line, one text for every spot, by what the line knows: a split line "200 pcs (1 Case)", a
 * factor-1 unit line its own word "2 Cases", and a legacy line the bare number the invoice prints. A legacy line can't
 * say boxes or pcs: only the server holds that evidence, and a label on it is stale.
 */
function lineCountText(line: ReturnLineSnapshot, count: number): string {
  const mode = lineCountMode(line);
  if (mode === "split") return returnLineQtyText(splitOf(count, line));
  if (mode === "legacy") return invoiceLineQtyText({ qty: count, unitLabel: null });
  return Number.isInteger(count)
    ? invoiceLineQtyText({ qty: count, boxes: count, pieces: 0, unitLabel: line.unitLabel })
    : invoiceLineQtyText({ qty: count, unitLabel: line.unitLabel });
}

/** What a line ordered: "400 pcs (2 Cases)", "10 Cases", "10". */
export function orderedItemQtyText(line: ReturnLineSnapshot): string {
  return lineCountText(line, Number(line.qty));
}

/** A returned item's quantity: a line item by its line, a pooled item (no line) in pcs. */
export function returnedItemQtyText(item: {
  qty: number | string;
  line?: ReturnLineSnapshot | null;
}): string {
  return item.line ? lineCountText(item.line, Number(item.qty)) : returnLineQtyText(item);
}
