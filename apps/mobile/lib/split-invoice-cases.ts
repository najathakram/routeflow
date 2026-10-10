import { invoiceLineQtyText } from "@routeflow/pricing";
import { isUnitLine } from "./invoice-line-unit";

/**
 * #2074 / SA-178 item 5 — Case guidance for SplitInvoiceScreen. GUIDANCE ONLY: a partial
 * Case is legitimate and billing never refuses it, so nothing here throws or blocks; it only
 * chooses defaults, step sizes and labels. Quantities stay in base pieces (the order line's
 * `qty`); the Case size is the LINE's own `unitsPerBox` (the unit factor on a units_v1 line).
 * Display goes through `invoiceLineQtyText` (the shared label-aware formatter) — no new
 * money math and no `qty * unitPrice` anywhere.
 */

export interface SplitCaseLine {
  unitLabel?: string | null;
  unitsPerBox?: number | null;
  unit?: string | null;
}

/** Pieces per Case for a unit line (label set, integer factor > 1); null for any other line. */
export function caseSizeOf(line: SplitCaseLine): number | null {
  if (!isUnitLine(line)) return null;
  const n = Number(line.unitsPerBox);
  return Number.isInteger(n) && n > 1 ? n : null;
}

const wholeCases = (qty: number, size: number) => Math.floor(qty / size + 1e-9);

/** Default draft quantity: whole Cases for a unit line, everything for any other line. */
export function defaultBillQty(remaining: number, size: number | null): number {
  if (size == null) return remaining;
  return wholeCases(remaining, size) * size;
}

/** "Half": whole Cases only (never a partial Case by accident); ceil(cap/2) for other lines. */
export function halfBillQty(cap: number, size: number | null): number {
  if (size == null) return Math.ceil(cap / 2);
  return Math.ceil(wholeCases(cap, size) / 2) * size;
}

/** Loose pieces beyond whole Cases (the "bill the remaining N pcs" action); 0 for other lines. */
export function remainderPieces(cap: number, size: number | null): number {
  if (size == null || cap <= 0) return 0;
  return Math.round(cap - wholeCases(cap, size) * size);
}

/** One stepper press: +/- one Case (1 for other lines), clamped to [0, cap]. */
export function stepBillQty(cur: number, dir: 1 | -1, cap: number, size: number | null): number {
  const next = cur + dir * (size ?? 1);
  return Math.min(Math.max(0, next), Math.max(0, cap));
}

/** "4 Cases + 4 pcs" for a unit line; the plain "<qty> <unit>" for any other line. */
export function formatSplitQty(qty: number, line: SplitCaseLine): string {
  const size = caseSizeOf(line);
  if (size == null) return `${qty} ${line.unit ?? "ea"}`;
  const boxes = wholeCases(qty, size);
  return invoiceLineQtyText({
    qty,
    boxes,
    pieces: Math.round(qty - boxes * size),
    unitLabel: line.unitLabel,
  });
}
