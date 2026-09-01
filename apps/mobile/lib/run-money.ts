/**
 * REG-B49 (spec R2): every driver money figure must derive from the server's
 * box-aware line money, never `qty * unitPrice` — for a boxed line
 * (`unitsPerBox > 1`) that multiplies the box price by the PIECE count and
 * over-charges by `unitsPerBox`. Prefer the server-computed `subtotal` when
 * the line carries one (it may arrive as a Prisma Decimal string over the
 * wire); fall back to `computeLineSubtotal` (mirrors the server's own boxed
 * proration) only when it doesn't. Pure — no React import — Jest-testable.
 */
import { computeLineSubtotal } from "./pricing";

export interface RunMoneyLineItem {
  qty: number;
  unitPrice: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  /** Prisma Decimal — may arrive as a string over the wire. */
  subtotal?: number | string | null;
}

export interface RunMoneyOrder {
  lineItems: RunMoneyLineItem[];
}

export interface RunMoneyStop {
  orders?: RunMoneyOrder[];
}

/** One line's money — server subtotal when present, else the box-aware fallback. */
export function lineItemSubtotal(line: RunMoneyLineItem): number {
  if (line.subtotal != null && line.subtotal !== "") return Number(line.subtotal);
  return computeLineSubtotal({
    unitPrice: Number(line.unitPrice ?? 0),
    qty: Number(line.qty ?? 0),
    boxes: line.boxes ?? undefined,
    pieces: line.pieces ?? undefined,
    unitsPerBox: line.unitsPerBox ?? undefined,
  });
}

export function sumOrderLineItems(order: RunMoneyOrder): number {
  return (order.lineItems ?? []).reduce((sum, li) => sum + lineItemSubtotal(li), 0);
}

export function sumStopOrders(stop: RunMoneyStop): number {
  return (stop.orders ?? []).reduce((sum, order) => sum + sumOrderLineItems(order), 0);
}
