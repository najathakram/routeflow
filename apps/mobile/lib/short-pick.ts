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

/** The shape `shortPickLinesFromOrder` reads off an order's own line items. */
export interface ShortPickSourceLine {
  id: string;
  productId: string | null;
  status?: string | null;
  deliveredQty?: number | string | null;
  qty: number | string;
  subtotal?: number | null;
  promoFreeUnits?: number | null;
  boxes?: number | null;
  unitsPerBox?: number | null;
  /** B648/SA-094: the units_v1 selling unit ("Case"…) — see ShortPickLine. */
  unitLabel?: string | null;
  product?: { unitsPerBox?: number | null } | null;
}

/** orderItemId -> pieces already delivered at OTHER visits (the run read's per-stop
 *  `deliveredSoFar` projection, B785/SA-116). Absent/0 = a first visit. */
export type DeliveredSoFarById = Readonly<Record<string, number>>;

/** Flattens the run read's stop snapshot (`stop.orders[].lineItems[].deliveredSoFar`) to a map. */
export function deliveredSoFarByLine(
  stopOrders:
    | readonly {
        lineItems?: readonly { id: string; deliveredSoFar?: number | string | null }[] | null;
      }[]
    | null
    | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of stopOrders ?? []) {
    for (const li of o.lineItems ?? []) {
      const n = Number(li.deliveredSoFar ?? 0);
      if (n > 0) out[li.id] = n;
    }
  }
  return out;
}

/**
 * B785/SA-116: whether the review screen offers a line at all. A line delivered on ANOTHER visit
 * (`soFar > 0`) is offered while some of it remains; otherwise the pre-B785 rule holds (nothing
 * delivered yet — a line whose only delivery is THIS stop's own is settled, never re-offered).
 */
export function isLineAdjustable(
  li: { status?: string | null; qty: number | string; deliveredQty?: number | string | null },
  soFar = 0,
): boolean {
  if (li.status === "CANCELLED") return false;
  if (soFar > 0) return Number(li.qty) - soFar > 0;
  return Number(li.deliveredQty ?? 0) === 0;
}

/**
 * B785/SA-116: the PER-VISIT view of a line — what THIS visit can still deliver. On a second visit
 * the ordered qty is the REMAINING (`qty − soFar`), the money is the agreed price of that remaining
 * portion (a display estimate; the server bills from evidence), and a unit-aware line's Case count
 * is `count − casesDeliveredSoFar` — so the stepper bound, the DELIVERED/PARTIAL type and the
 * default explicit entry all read remaining, never the full order. A first visit (`soFar` 0) is
 * returned untouched.
 */
function visitView(li: ShortPickSourceLine, soFar: number) {
  const qty = Number(li.qty);
  const freeUnitSize = freeUnitSizeFor(li);
  if (!(soFar > 0)) {
    return {
      orderedQty: qty,
      subtotal: li.subtotal ?? null,
      freeUnits: li.promoFreeUnits ?? 0,
      freeUnitSize,
      boxes: li.boxes ?? null,
    };
  }
  const remaining = Math.max(0, qty - soFar);
  const upb = Number(li.unitsPerBox ?? 0);
  return {
    orderedQty: remaining,
    subtotal:
      li.subtotal == null
        ? null
        : prorateLineSubtotal(li.subtotal, remaining, qty, li.promoFreeUnits ?? 0, freeUnitSize),
    freeUnits: 0, // already netted out of the prorated subtotal above
    freeUnitSize: 1,
    boxes: li.boxes != null && upb > 0 ? Math.round(remaining / upb) : (li.boxes ?? null),
  };
}

/**
 * An order's lines -> `ShortPickLine[]` (B762): the SAME mapping
 * short-pick.tsx and payment.tsx each used to inline separately, byte-
 * identical between them by convention — both screens feed the same
 * `reconciledTotal`/`buildDeliveries`/`buildStopDeliveries`, so a single
 * shared derivation is what keeps that convention enforced rather than
 * merely documented. Excludes CANCELLED lines (not adjustable) and lines
 * already delivered (a reopened, partially-completed stop shouldn't
 * re-offer an already-settled line). B785: a line partly delivered at an
 * EARLIER visit (`soFarById`) is re-offered at its remaining qty.
 */
export function shortPickLinesFromOrder(
  order: { lineItems?: readonly ShortPickSourceLine[] | null } | null | undefined,
  soFarById: DeliveredSoFarById = {},
): ShortPickLine[] {
  return (order?.lineItems ?? [])
    .filter((li) => isLineAdjustable(li, soFarById[li.id] ?? 0))
    .map((li) => ({
      orderItemId: li.id,
      productId: li.productId,
      ...visitView(li, soFarById[li.id] ?? 0),
      // B648/SA-094 (carried through the B762 merge): without these,
      // isUnitAwareLine reads every multi-order line as a plain pack line —
      // a Case line loses its whole-Case stepper and normalizeDeliveryPlan's
      // snap the moment it's reviewed through the multi-order fan-out.
      unitLabel: li.unitLabel ?? null,
      unitsPerBox: li.unitsPerBox ?? null,
    }));
}

/** The shape `fallbackShortPickLines` reads off the STOP's own embedded snapshot. */
export interface StopSnapshotLine {
  id: string;
  productId: string | null;
  status?: string | null;
  qty: number | string;
  subtotal?: number | string | null;
  /** B648/SA-094: without these, a Case line falling back to this snapshot
   *  (its richer per-order fetch hasn't landed) reads as a plain pack line
   *  and normalizeDeliveryPlan never snaps its qty to a whole Case. */
  boxes?: number | null;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
  /** B785/SA-116: pieces delivered at OTHER visits (run read projection). */
  deliveredSoFar?: number | string | null;
}

/**
 * SA-115: the delivery-payload lines for an order whose richer per-order
 * fetch has NOT LANDED — built from the STOP's own embedded snapshot
 * (already available with no extra fetch), so `closeStop` (payment.tsx)
 * still covers the order rather than blocking on every order's fetch
 * (which would cost only a spinner, but also break an offline close). The
 * CALLER is responsible for using this ONLY when the order's fetch truly
 * hasn't landed — never merely because `shortPickLinesFromOrder` came back
 * empty for a LANDED order (that's a real "nothing adjustable" state, not
 * missing data, and must send zero entries, not re-claim full delivery).
 *
 * CANCELLED lines are filtered (SA-115 required (1), reasoning corrected in
 * SA-115a): `status` rides this snapshot on the wire, and an office cancel
 * leaves `qty` untouched, so an unfiltered map would send a CANCELLED line
 * as DELIVERED at full qty. Billing it isn't live on master today, but the
 * server would still stamp `deliveredQty` on the cancelled line and write
 * a DELIVERED mutation row for it — false evidence every later reader of
 * those rows (audit, reports, a future billing path) trusts as real.
 *
 * No BOGO netting (`freeUnits: 0`/`freeUnitSize: 1`): a `deliveredQtyById`
 * override can't realistically exist for an order whose review screen
 * never loaded to record one, so every surviving line resolves to
 * `deliveryTypeForQty`'s DELIVERED-at-full-qty case regardless.
 *
 * SA-115 residual (accepted, filed separately, not B762): this snapshot
 * carries no `deliveredQty`, so a re-delivery stop for an order that never
 * loaded here would re-claim full delivery rather than "the remaining N".
 */
export function fallbackShortPickLines(
  order: { lineItems?: readonly StopSnapshotLine[] | null } | null | undefined,
): ShortPickLine[] {
  return (
    (order?.lineItems ?? [])
      // B785/SA-116: the snapshot carries `deliveredSoFar`, so a later visit's fallback entry is
      // the REMAINING, never a re-claim of the full order (closes the SA-115 residual below); a
      // line with nothing remaining is dropped rather than re-sent.
      .filter(
        (li) =>
          li.status !== "CANCELLED" &&
          !(
            Number(li.deliveredSoFar ?? 0) > 0 &&
            Number(li.qty ?? 0) - Number(li.deliveredSoFar) <= 0
          ),
      )
      .map((li) => {
        const soFar = Number(li.deliveredSoFar ?? 0);
        const qty = Number(li.qty ?? 0);
        const remaining = soFar > 0 ? Math.max(0, qty - soFar) : qty;
        const upb = Number(li.unitsPerBox ?? 0);
        return {
          orderItemId: li.id,
          productId: li.productId,
          orderedQty: remaining,
          subtotal:
            li.subtotal == null
              ? null
              : soFar > 0
                ? prorateLineSubtotal(Number(li.subtotal), remaining, qty, 0, 1)
                : Number(li.subtotal),
          freeUnits: 0,
          freeUnitSize: 1,
          // B648/SA-094 (carried through the B762 merge) — see StopSnapshotLine.
          unitLabel: li.unitLabel ?? null,
          unitsPerBox: li.unitsPerBox ?? null,
          boxes:
            soFar > 0 && li.boxes != null && upb > 0
              ? Math.round(remaining / upb)
              : (li.boxes ?? null),
        };
      })
  );
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
 * SA-094a review (5), made a PER-ORDER check for the B762 multi-order stop
 * (B648/B762 merge adaptation item 4): true when the driver already
 * recorded a short-pick choice for one of THIS order's own lines (an entry
 * in `deliveredQtyById` — shared/flat across every order at the stop,
 * keyed by orderItemId, matched against `orderItemIds` from the STOP's own
 * embedded snapshot, always available even pre-fetch) but this SPECIFIC
 * order's richer per-order fetch hasn't landed yet (`landed` false) —
 * closing the stop right now would silently DISCARD that choice for this
 * order: `fallbackShortPickLines`'s un-landed path carries no
 * `deliveredQty`, so it would deliver this order in full instead of what
 * the driver actually recorded. The caller must refuse to close (not
 * silently drop the plan) until this order's data loads. `landed` is true
 * once ANY line loaded is irrelevant — pass whether the order's OWN fetch
 * (e.g. `!!ordersById[orderId]`) has resolved.
 */
export function planPendingButLinesNotLoaded(
  deliveredQtyById: Record<string, number>,
  orderItemIds: readonly string[],
  landed: boolean,
): boolean {
  if (landed) return false;
  return orderItemIds.some((id) => id in deliveredQtyById);
}

/** One order's worth of `buildDeliveries` inputs, for a multi-order stop. */
export interface StopOrderDeliveryPlan {
  orderId: string;
  lines: ShortPickLine[];
  /** Missing lines default to their full ordered qty (buildDeliveries) — an
   *  order the driver never touched still contributes explicit DELIVERED
   *  entries, never zero entries. To mark a whole order refused, every one
   *  of its lines must be present here at 0 — omission is never "refused". */
  deliveredQtyById: Record<string, number>;
}

export interface StopDeliveryEntry {
  orderItemId: string;
  productId: string | null;
  type: DeliveryType;
  quantityDelivered: number;
}

/**
 * The `deliveries` array for `useCompleteWithPayment`, across EVERY order at
 * a multi-order stop (B762/SA-109/SA-109a). Full coverage per order, never
 * omission: `buildDeliveries` already defaults an order's untouched lines to
 * their full ordered qty/DELIVERED, so an order this array includes with an
 * EMPTY `deliveredQtyById` still emits one explicit entry per line — the
 * server reads a wholly OMITTED order (missing from this array entirely) as
 * fully UNDELIVERED, so every order at the stop the driver actually handled
 * must appear here, never be left out. `type` is always
 * `deliveryTypeForQty(qty, orderedQty)`, matching `quantityDelivered`
 * exactly — the server 400s a type/qty mismatch (SA-109a): REFUSED only at
 * qty 0, DELIVERED only at the full ordered qty, PARTIAL otherwise.
 */
export function buildStopDeliveries(orders: StopOrderDeliveryPlan[]): StopDeliveryEntry[] {
  return orders.flatMap((o) =>
    buildDeliveries(o.lines, o.deliveredQtyById).map((d) => ({
      orderItemId: d.orderItemId,
      productId: d.productId,
      type: d.type,
      quantityDelivered: d.qty,
    })),
  );
}
