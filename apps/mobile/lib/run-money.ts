/**
 * REG-B49 (spec R2): every driver money figure must derive from the server's
 * box-aware line money, never `qty * unitPrice` — for a boxed line
 * (`unitsPerBox > 1`) that multiplies the box price by the PIECE count and
 * over-charges by `unitsPerBox`. Prefer the server-computed `subtotal` when
 * the line carries one (it may arrive as a Prisma Decimal string over the
 * wire); fall back to `computeLineSubtotal` (mirrors the server's own boxed
 * proration) only when it doesn't. Pure — no React import — Jest-testable.
 */
import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";

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
  /** Prisma Decimals — may arrive as strings over the wire. */
  subtotal?: number | string | null;
  tax?: number | string | null;
  total?: number | string | null;
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

/**
 * REG-B305: the driver "amount due" is the server's tax-inclusive total, not
 * the pre-tax line subtotal. Falls back to `sumOrderLineItems` (legacy
 * pre-tax basis) only when the payload carries no `total` yet.
 */
export function orderAmountDue(order: RunMoneyOrder): number {
  if (order.total != null && order.total !== "") return Number(order.total);
  return sumOrderLineItems(order);
}

export function stopAmountDue(stop: RunMoneyStop): number {
  return (stop.orders ?? []).reduce((sum, order) => sum + orderAmountDue(order), 0);
}

/**
 * REG-B305: reproduces invoices.service.ts:1454-1456's proration of an
 * order's tax by delivered/ordered subtotal (discount/fee stay whole).
 */
export function reconciledAmountDue(input: {
  orderSubtotal: number;
  orderTax: number;
  orderTotal: number;
  reconciledSubtotal: number;
}): number {
  const { orderSubtotal, orderTax, orderTotal, reconciledSubtotal } = input;
  if (!(orderSubtotal > 0) || !Number.isFinite(orderTotal) || !Number.isFinite(orderTax)) {
    return reconciledSubtotal;
  }
  const deliveredShare = reconciledSubtotal / orderSubtotal;
  const taxCarried = orderTax * (1 - deliveredShare);
  return roundMoney(orderTotal - (orderSubtotal - reconciledSubtotal) - taxCarried);
}
