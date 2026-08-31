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
  /**
   * BUY_N_GET_M snapshot: whole free SELLING units already netted out of
   * `subtotal` (mirrors `OrderItem.promoFreeUnits`). Default 0 — REG-B50:
   * omitting this on a promo line makes `reconciledTotal` silently fall back
   * to the plain linear proration, which over/under-bills a partial delivery.
   */
  freeUnits?: number;
  /**
   * Piece-equivalents per whole free unit — `unitsPerBox` on a BOX-SPLIT line
   * (`OrderItem.boxes != null`), 1 otherwise. `freeUnits` counts BOXES on such
   * a line while `orderedQty` counts PIECES, so without this bridge the
   * proration under-bills a partial by up to one box (the server oracle's
   * `freeUnitSize`, invoices.service.ts). Default 1 = both already on the same
   * axis, which is every selling-unit line.
   */
  freeUnitSize?: number;
}

/**
 * `ShortPickLine.freeUnitSize` for an order line — the server oracle's
 * `freeUnitSize` (invoices.service.ts#buildInvoiceItemData), derived the same
 * way: a line stored WITH a box/piece split (`boxes != null`) counts its free
 * units in BOXES while its `qty` is in PIECES, so one free unit is worth
 * `unitsPerBox` pieces there; every other line is already on a single axis, so
 * it is 1. Prefers the line's SALE-TIME `unitsPerBox` snapshot over the live
 * product (a later packaging change must not re-price an agreed line), falling
 * back to `product.unitsPerBox` for legacy rows created before that column
 * shipped — same order as the oracle.
 *
 * Both driver screens map their lines through this and feed the SAME
 * `reconciledTotal`, so neither may derive it on its own.
 */
export function freeUnitSizeFor(li: {
  boxes?: number | null;
  unitsPerBox?: number | null;
  product?: { unitsPerBox?: number | null } | null;
}): number {
  if (li.boxes == null) return 1;
  const upb = Math.trunc(Number(li.unitsPerBox ?? li.product?.unitsPerBox ?? 0));
  return upb > 0 ? upb : 1;
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
 * stored subtotal prorated by delivered/ordered qty AND the line's
 * `freeUnits`/`freeUnitSize` snapshot (server-exact formula, see
 * pricing.ts#prorateLineSubtotal — its paid-basis floored cumulative
 * telescope, not a plain linear ratio). REFUSED lines contribute $0. Display
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
    sum += prorateLineSubtotal(
      li.subtotal,
      clamped,
      li.orderedQty,
      li.freeUnits ?? 0,
      li.freeUnitSize ?? 1,
    );
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
