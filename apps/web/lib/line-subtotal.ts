import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";

type Numeric = number | string | null | undefined;

export interface StoredOrComputedLineInput {
  /** Server-stored, post-discount line subtotal — the agreed money. Wins whenever present. */
  subtotal?: Numeric;
  /** Total PIECES for a boxed line (the server's axis), plain quantity otherwise. */
  qty: Numeric;
  /** The BOX price for a line with a boxes/pieces split, the piece price otherwise. */
  unitPrice: Numeric;
  boxes?: Numeric;
  pieces?: Numeric;
  /** Sale-time box-size snapshot on the line. */
  unitsPerBox?: Numeric;
  /** Live product box size — only consulted when the line carries no snapshot. */
  product?: { unitsPerBox?: Numeric; [key: string]: unknown } | null;
  /** BUY_N_GET_M snapshot: whole free selling units (boxes for a boxed line). */
  promoFreeUnits?: Numeric;
  /** Per-line money discount, already off the stored subtotal. */
  discount?: Numeric;
}

const num = (v: Numeric): number => Number(v ?? 0) || 0;
const optNum = (v: Numeric): number | null => (v == null ? null : Number(v));

/**
 * The amount to DISPLAY for an invoice / estimate line.
 *
 * The stored subtotal is authoritative (boxed-aware, post-discount, rounded by the server). Only
 * when a payload omits it do we re-price — through `@routeflow/pricing`, NEVER `qty * unitPrice`,
 * which over-charges a boxed line (qty = pieces, unitPrice = BOX price) by `unitsPerBox`.
 */
export function storedOrComputedLineSubtotal(line: StoredOrComputedLineInput): number {
  if (line.subtotal != null) return Number(line.subtotal);
  const beforeDiscount = computeLineSubtotal({
    unitPrice: num(line.unitPrice),
    qty: num(line.qty),
    boxes: optNum(line.boxes),
    pieces: optNum(line.pieces),
    unitsPerBox: optNum(line.unitsPerBox) ?? optNum(line.product?.unitsPerBox),
    freeUnits: Math.max(0, Math.trunc(num(line.promoFreeUnits))),
  });
  return Math.max(0, roundMoney(beforeDiscount - num(line.discount)));
}
