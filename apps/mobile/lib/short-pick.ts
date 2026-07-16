/**
 * At-delivery short/refuse reconciliation. The server
 * (apps/api/src/orders/orders.service.ts:3095-3330, invoked from
 * routes.service.ts#completeStop/completeWithPayment) already fully supports
 * per-line PARTIAL/REFUSED delivery with correct proration — this module only
 * builds the client-side delivery plan + a matching ESTIMATED total; it never
 * invents new server behavior. Pure — no RN/api-client import — Jest-testable.
 */
import { prorateLineSubtotal, roundMoney } from "./pricing";

export type DeliveryType = "DELIVERED" | "PARTIAL" | "REFUSED";

export interface ShortPickLine {
  orderItemId: string;
  productId: string | null;
  /** The order line's original qty (piece-equivalent). */
  orderedQty: number;
  /** Stored line subtotal — the agreed money for the FULL ordered qty. */
  subtotal: number | null;
}

/** DELIVERED at the full ordered qty, REFUSED at 0, else PARTIAL. */
export function deliveryTypeForQty(deliveredQty: number, orderedQty: number): DeliveryType {
  if (deliveredQty <= 0) return "REFUSED";
  if (deliveredQty >= orderedQty) return "DELIVERED";
  return "PARTIAL";
}

export interface PlannedDelivery {
  orderItemId: string;
  /** Null for an unlisted (ad-hoc) line — the server keys on orderItemId and ignores this. */
  productId: string | null;
  type: DeliveryType;
  qty: number;
}

/**
 * Build the `deliveries` array for useCompleteWithPayment.
 * `deliveredQtyById` holds only the lines the driver actually changed from
 * the default (full ordered qty) — matches the diff-only convention the rest
 * of the app uses (buildOrderItemDiff, buildAtDoorChangeRequests). Unlisted
 * ad-hoc lines (productId null, `name` set) are INCLUDED: the server keys
 * every delivery on orderItemId and derives productId from the DB row itself
 * (apps/api/src/orders/orders.service.ts:3115-3125 ignores the client-sent
 * productId), so an unlisted line still delivers and invoices correctly.
 * These lines must stay in step with reconciledTotal — which also charges for
 * them — otherwise the driver collects money for a line the server never marks
 * delivered, and an all-unlisted order can never complete (deliveries empty →
 * payment.tsx's `deliveries.length === 0` guard blocks the stop).
 */
export function buildDeliveries(
  lines: ShortPickLine[],
  deliveredQtyById: Record<string, number>,
): PlannedDelivery[] {
  const out: PlannedDelivery[] = [];
  for (const li of lines) {
    const raw = deliveredQtyById[li.orderItemId] ?? li.orderedQty;
    const clamped = Math.max(0, Math.min(raw, li.orderedQty));
    out.push({
      orderItemId: li.orderItemId,
      productId: li.productId,
      type: deliveryTypeForQty(clamped, li.orderedQty),
      qty: clamped,
    });
  }
  return out;
}

/**
 * The reconciled ESTIMATE shown on the payment screen — sum of each line's
 * stored subtotal prorated by delivered/ordered qty (server-exact formula,
 * see pricing.ts#prorateLineSubtotal). REFUSED lines contribute $0. Display
 * estimate only; the server computes the real invoice total independently
 * via the identical formula.
 */
export function reconciledTotal(
  lines: ShortPickLine[],
  deliveredQtyById: Record<string, number>,
): number {
  let sum = 0;
  for (const li of lines) {
    const raw = deliveredQtyById[li.orderItemId] ?? li.orderedQty;
    const clamped = Math.max(0, Math.min(raw, li.orderedQty));
    sum += prorateLineSubtotal(li.subtotal, clamped, li.orderedQty);
  }
  return roundMoney(sum);
}

/** True when every line is still at its default (fully delivered) qty. */
export function isFullyDelivered(
  lines: ShortPickLine[],
  deliveredQtyById: Record<string, number>,
): boolean {
  return lines.every((li) => (deliveredQtyById[li.orderItemId] ?? li.orderedQty) >= li.orderedQty);
}
