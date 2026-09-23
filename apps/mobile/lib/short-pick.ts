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
   * null/undefined for a plain piece/pack line. `orderedQty` on such a line
   * is base PIECES (count × the line's own `unitsPerBox` snapshot).
   */
  unitLabel?: string | null;
  /**
   * SA-094: the line's own selling-unit-per-base-pack factor snapshot
   * (`OrderItem.unitsPerBox`). `isUnitAwareLine` requires this to be > 1 —
   * `unit-line-build.ts` stores a FACTOR-1 unit line ("Piece") with
   * `boxes: null`, `unitsPerBox: 1`, and its pieces ARE individually
   * countable, so it keeps the ordinary piece stepper (a units_v1 line whose
   * "unit" already IS a piece has no whole-case granularity to protect).
   */
  unitsPerBox?: number | null;
  /**
   * SA-094a: the STORED count of the selling unit on this line
   * (`unit-line-build.ts` stores `boxes = count` for a factor>1 unit line —
   * "stored like a box-split line whose 'box' is the unit"). The whole-Case
   * stepper's upper bound; never derived from the live product.
   */
  boxes?: number | null;
}

/**
 * B648/SA-094: true when a line is sold by a units_v1 unit whose OWN pack
 * snapshot is > 1 base piece per unit — the case a piece-counting stepper
 * cannot represent one-for-one, so it gets the whole-Case stepper instead
 * (see `effectiveDeliveredQty`). A factor-1 unit line (`unitsPerBox` 1 or
 * absent, e.g. "Piece") is EXCLUDED here even though `unitLabel` is set — its
 * pieces are individually countable, so it keeps the ordinary piece stepper
 * and clamp. Exported so the review screen can pick which control to render.
 */
export function isUnitAwareLine(li: Pick<ShortPickLine, "unitLabel" | "unitsPerBox">): boolean {
  return (li.unitLabel ?? "").trim() !== "" && Number(li.unitsPerBox ?? 0) > 1;
}

/**
 * B648/SA-094a: the delivered qty this module ever uses for a line. For a
 * unit-aware line (`isUnitAwareLine`, factor > 1), `deliveredQtyById`'s raw
 * entry SNAPS DOWN to the nearest whole multiple of the line's own
 * `unitsPerBox` — `clamp(floor(raw / unitsPerBox) * unitsPerBox, 0,
 * orderedQty)` — so a stray/leftover piece count (e.g. 300 on a 288-piece
 * Case) can never leak a fractional Case into the money math (300 -> 288,
 * one whole Case, never 300 pieces of "partial"). n=0 -> REFUSED, n=count ->
 * DELIVERED, anything between -> PARTIAL at that many WHOLE cases. No entry
 * at all is the universal "untouched" default every other line already
 * uses: fully delivered. Every function below reads through this ONE place —
 * `normalizeDeliveryPlan` exports the same snapping for every caller that
 * needs a full plan map, not just one line's value (SA-094b's normalizer
 * requirement: the category-tax half and the review row's own badge must
 * read the SAME snapped number reconciledTotal/buildDeliveries already do).
 */
function effectiveDeliveredQty(
  li: Pick<ShortPickLine, "orderItemId" | "orderedQty" | "unitLabel" | "unitsPerBox">,
  deliveredQtyById: Record<string, number>,
): number {
  const raw = deliveredQtyById[li.orderItemId];
  if (isUnitAwareLine(li)) {
    if (raw == null) return li.orderedQty;
    const upb = Number(li.unitsPerBox);
    const snapped = Math.floor(Math.max(0, raw) / upb) * upb;
    return Math.max(0, Math.min(snapped, li.orderedQty));
  }
  return Math.max(0, Math.min(raw ?? li.orderedQty, li.orderedQty));
}

/**
 * SA-094b: the SAME `effectiveDeliveredQty` snap, for every line in one
 * call — the map every caller must pass to BOTH money halves
 * (`deliveredCategoryTax`/`shortPickCategoryTax`, which have no
 * unit-awareness of their own) AND the review row's displayed qty/badge.
 * Reading the raw `deliveredQtyById` in only one of those places is exactly
 * how a stray 288-of-864 entry used to bill the full subtotal (via
 * `reconciledTotal`, already normalized) while charging only a third of the
 * category tax (via the un-normalized `deliveredCategoryTax`) and showing a
 * "Short" badge next to a "Delivered" total.
 */
export function normalizeDeliveryPlan(
  lines: ShortPickLine[],
  deliveredQtyById: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const li of lines) {
    out[li.orderItemId] = effectiveDeliveredQty(li, deliveredQtyById);
  }
  return out;
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

/**
 * SA-094a review (5): true when the driver already recorded short-pick
 * choices for this stop (a non-empty `deliveredQtyById`, persisted in
 * useDeliveryPlanStore from an earlier short-pick screen visit) but the
 * order's richer data hasn't loaded yet (`shortPickLines` empty) — closing
 * the stop right now would silently DISCARD those choices: payment.tsx's
 * `reconciledFirst` derives from `shortPickLines`, so it would read `null`
 * and order[0] would fall through to the "every other order" branch,
 * delivering everything in full instead of what the driver actually
 * recorded. The caller must refuse to close (not silently drop the plan)
 * until `shortPickLines` loads.
 */
export function planPendingButLinesNotLoaded(
  deliveredQtyById: Record<string, number>,
  shortPickLines: ShortPickLine[],
): boolean {
  return Object.keys(deliveredQtyById).length > 0 && shortPickLines.length === 0;
}
