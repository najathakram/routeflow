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

/**
 * REG-B305 round 2: the order's single OPEN DRAFT INVOICE, as the server last
 * computed it (status DRAFT, deliveryBatchId null; `total = subtotal +
 * taxAmount + shippingFee - discount`, `taxAmount` already folds regular +
 * category tax). This — not `Order.total` — is the basis for the driver's
 * amount due: `Order.total` carries NO discount and, on a split delivery,
 * the WHOLE shipping fee on every visit.
 */
export interface RunMoneyInvoice {
  id: string;
  subtotal: number | string | null;
  taxAmount: number | string | null;
  discount: number | string | null;
  shippingFee: number | string | null;
  total: number | string | null;
}

export interface RunMoneyOrder {
  lineItems: RunMoneyLineItem[];
  /** Prisma Decimals — may arrive as strings over the wire. */
  subtotal?: number | string | null;
  tax?: number | string | null;
  total?: number | string | null;
  /** REG-B305 round 2 — see RunMoneyInvoice; used only by the no-draft fallback. */
  discountAmount?: number | string | null;
  shippingFee?: number | string | null;
  /** The order's open draft invoice, when the payload carries one. */
  invoices?: RunMoneyInvoice[];
}

export interface RunMoneyStop {
  orders?: RunMoneyOrder[];
}

/** `Number(v)` guarded so null/""/non-finite input comes back `null`, never NaN. */
function finiteOrNull(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

/** The order's single open draft invoice, when the payload carries one. */
export function draftMoney(order: RunMoneyOrder): RunMoneyInvoice | undefined {
  return order.invoices?.[0];
}

/**
 * REG-B305 round 2 (Opus BLOCKER on round 1's basis): the driver "amount due"
 * is the order's OPEN DRAFT INVOICE as the server last computed it —
 * `Order.total` carries no discount and, on a split delivery, the WHOLE
 * shipping fee on every visit, so it can only ever be a fallback.
 *
 *  (a) a draft invoice with a finite `total` -> that total, rounded;
 *  (b) else a finite `Order.total` -> `total - discountAmount` (a fallback
 *      for a payload without the draft; the fee allocation of a split
 *      delivery is only right for the FIRST visit here, since `Order.total`
 *      does not know which visit it is);
 *  (c) else the pre-tax line sum (`sumOrderLineItems`).
 *
 * Every `Number()` is guarded by `Number.isFinite` (via `finiteOrNull`) —
 * this never returns NaN.
 */
export function orderAmountDue(order: RunMoneyOrder): number {
  const draft = draftMoney(order);
  const draftTotal = draft ? finiteOrNull(draft.total) : null;
  if (draftTotal != null) return roundMoney(draftTotal);

  const orderTotal = finiteOrNull(order.total);
  if (orderTotal != null) {
    const discount = finiteOrNull(order.discountAmount) ?? 0;
    return roundMoney(orderTotal - discount);
  }

  return sumOrderLineItems(order);
}

export function stopAmountDue(stop: RunMoneyStop): number {
  return (stop.orders ?? []).reduce((sum, order) => {
    const due = orderAmountDue(order);
    return Number.isFinite(due) ? sum + due : sum;
  }, 0);
}

export interface ReconciledAmountDueInput {
  /**
   * The order's open draft invoice (or just the fields off it). Omit when
   * the payload carries no draft — the result then falls back to the
   * pre-tax `reconciledSubtotal` alone (legacy basis).
   */
  draft?: {
    subtotal: number | string | null;
    taxAmount: number | string | null;
    discount: number | string | null;
    shippingFee: number | string | null;
  } | null;
  /** The delivered/short-picked share of the order's pre-tax subtotal. */
  reconciledSubtotal: number;
}

/**
 * REG-B305 round 2: reproduces invoices.service.ts's proration of a
 * short-picked order's tax (incl. category tax) by delivered/ordered
 * subtotal off the DRAFT invoice — discount and the ALLOCATED shipping fee
 * stay whole (they don't prorate by delivered qty), only tax scales with the
 * delivered share. Exact for uniform lines; an approximation when a per-unit
 * excise tax concentrates on specific lines within the order (documented,
 * not a bug — the server folds category tax into one order-level
 * `taxAmount`, so the client has no per-line breakdown to prorate more
 * precisely).
 */
export function reconciledAmountDue(input: ReconciledAmountDueInput): number {
  const reconciledSubtotal = Number.isFinite(input.reconciledSubtotal)
    ? input.reconciledSubtotal
    : 0;
  const { draft } = input;
  if (!draft) return reconciledSubtotal;

  const draftSubtotal = finiteOrNull(draft.subtotal);
  const taxAmount = finiteOrNull(draft.taxAmount) ?? 0;
  const discount = finiteOrNull(draft.discount) ?? 0;
  const shippingFee = finiteOrNull(draft.shippingFee) ?? 0;
  const share = draftSubtotal != null && draftSubtotal > 0 ? reconciledSubtotal / draftSubtotal : 1;
  return roundMoney(reconciledSubtotal - discount + shippingFee + taxAmount * share);
}
