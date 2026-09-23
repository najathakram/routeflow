/**
 * At-delivery short/refuse reconciliation. The server
 * (apps/api/src/orders/orders.service.ts:3095-3330, invoked from
 * routes.service.ts#completeStop/completeWithPayment) already fully supports
 * per-line PARTIAL/REFUSED delivery with correct proration — this module only
 * builds the client-side delivery plan + a matching ESTIMATED total; it never
 * invents new server behavior. Pure — no RN/api-client import — Jest-testable.
 */
import { prorateLineSubtotal, roundMoney } from "@routeflow/pricing";

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
  /**
   * B648: the units_v1 selling unit ("Case", "Pallet"…) this line is sold by;
   * null/undefined for a plain piece/pack line. `orderedQty` on a unit-aware
   * line is base PIECES (count × the line's own `unitsPerBox` snapshot), and
   * a delivered qty other than a whole multiple of the case size has no
   * physical meaning a piece-counting stepper can represent — a PARTIAL
   * count is REFUSED (this module has no case-aware stepper to offer).
   * REFUSING partial is not the same as FORCING full, though: a unit-aware
   * line still supports the same binary DELIVERED/REFUSED choice every other
   * line does. An earlier version of this fix hid the choice entirely and
   * always billed such a line in full, which would silently over-charge the
   * customer for a Case the driver genuinely could not deliver (the B663
   * class: a short delivery billed in full). `effectiveDeliveredQty` below
   * resolves this — 0 or `orderedQty`, never an implicit full and never a
   * raw piece count in between.
   */
  unitLabel?: string | null;
}

/** B648: true when a line is sold by a units_v1 unit and so only supports a binary delivered/not-delivered choice — see `ShortPickLine.unitLabel`. Exported so the review screen can render that choice instead of a piece stepper. */
export function isUnitAwareLine(li: Pick<ShortPickLine, "unitLabel">): boolean {
  return (li.unitLabel ?? "").trim() !== "";
}

/**
 * B648: the delivered qty this module ever uses for a line. For a unit-aware
 * line, `deliveredQtyById`'s entry (when present) snaps to a BINARY 0 or the
 * full `orderedQty` — never the raw value in between, so a stray/leftover
 * piece count (e.g. a value from before the line was known to be
 * unit-aware) can never leak into the money math as a fractional case. No
 * entry at all is the universal "untouched" default every other line
 * already uses: fully delivered — this is NOT the bug an earlier version of
 * this fix had (that version ignored the entry ENTIRELY, so there was no
 * way to ever record a genuine "not delivered"; this version honors an
 * explicit 0, it just never treats a non-zero, non-full entry as a partial
 * case). Every function below reads through this ONE place.
 */
function effectiveDeliveredQty(
  li: Pick<ShortPickLine, "orderItemId" | "orderedQty" | "unitLabel">,
  deliveredQtyById: Record<string, number>,
): number {
  if (isUnitAwareLine(li)) {
    const raw = deliveredQtyById[li.orderItemId];
    return raw == null || raw > 0 ? li.orderedQty : 0;
  }
  const raw = deliveredQtyById[li.orderItemId] ?? li.orderedQty;
  return Math.max(0, Math.min(raw, li.orderedQty));
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
    const clamped = effectiveDeliveredQty(li, deliveredQtyById);
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
    const clamped = effectiveDeliveredQty(li, deliveredQtyById);
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
  return lines.every((li) => effectiveDeliveredQty(li, deliveredQtyById) >= li.orderedQty);
}
