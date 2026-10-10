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
  /**
   * SA-175/FIX 6: pieces left over after `boxes` whole units of `unitsPerBox` — always
   * `orderedQty - boxes*unitsPerBox`; null when no split is known (`unitsPerBox` missing or
   * <= 1). A REMAINING view (second visit) is not always an exact multiple of the case size —
   * some of it may have been delivered piecemeal at another visit — so the stepper needs the
   * TRUE remainder, never one a `Math.round` rounded away.
   */
  pieces?: number | null;
  /**
   * SA-367a: the run read served NO `remaining` for this line (an api older than #1353). The client
   * never derives the remaining itself, so there is no default: the stepper starts EMPTY and the
   * driver must enter what was delivered — never the full qty. `orderedQty` then carries the line's
   * qty only as the input ceiling (the server's 400 is the real bound). See `linesAwaitingEntry`.
   */
  needsEntry?: boolean;
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

// ─── Whole-Case stepper math (FIX 6, SA-175) ───────────────────────────────────
//
// `ordered` is the line's REMAINING qty (a second visit) or its full qty (a first visit) — not
// always an exact multiple of `unitsPerBox`. `caseStepperCasesDelivered` FLOORS, never rounds:
// a rounded-up Case count can bound the stepper's top above what actually remains (30 left of a
// 12-Case rounds to "3 of 3" = 36, over-delivering — the server's own fit check then refuses the
// submit). The stepper's true top value is always exactly `ordered` itself (the last, partial
// step) — never `floor(ordered/unitsPerBox) * unitsPerBox`, which can be LESS than `ordered` and
// would silently strand a partial Case's worth of pieces as undeliverable.
//
// Pulled out of the review row (short-pick.tsx) as pure functions per this project's
// mobile-tests-are-pure-logic-only convention — the money-relevant part of a stepper widget is
// exactly the part that must be independently, deterministically testable.

/** Whole Cases `qty` represents — floored and capped at the whole Cases `ordered` allows. The
 *  shared basis every function below reads, so display and both step directions can never
 *  disagree on what "N Cases" means for a given qty. */
export function caseStepperCasesDelivered(
  qty: number,
  ordered: number,
  unitsPerBox: number,
): number {
  if (unitsPerBox <= 0) return 0;
  const caseCount = Math.floor(ordered / unitsPerBox);
  const clampedQty = Math.max(0, Math.min(qty, ordered));
  return Math.min(caseCount, Math.floor(clampedQty / unitsPerBox));
}

/** Pieces left over after the whole Cases `ordered` contains — 0 when `ordered` is an exact
 *  multiple of `unitsPerBox`. */
export function caseStepperRemainderPieces(ordered: number, unitsPerBox: number): number {
  if (unitsPerBox <= 0) return 0;
  return Math.max(0, ordered - Math.floor(ordered / unitsPerBox) * unitsPerBox);
}

/**
 * One step DOWN. The top state (`qty === ordered`, including any partial-Case remainder) steps
 * down to `casesDelivered` WHOLE Cases first (dropping just the remainder); every step below
 * that drops one whole Case. Always reaches 0 — the driver can refuse the line even when less
 * than one whole Case remains (`ordered < unitsPerBox`, `casesDelivered` 0 throughout).
 */
export function caseStepperDecrement(qty: number, ordered: number, unitsPerBox: number): number {
  if (unitsPerBox <= 0) return 0;
  const casesDelivered = caseStepperCasesDelivered(qty, ordered, unitsPerBox);
  const remainderPieces = caseStepperRemainderPieces(ordered, unitsPerBox);
  const atFull = qty >= ordered;
  const next =
    atFull && remainderPieces > 0
      ? casesDelivered * unitsPerBox
      : Math.max(0, casesDelivered - 1) * unitsPerBox;
  return Math.max(0, next);
}

/**
 * One step UP. Its top value is exactly `ordered` — never `caseCount * unitsPerBox`, which can
 * be LESS than `ordered` (a partial Case still remains) and is never MORE (`ordered` is already
 * the true, floored-and-remaindered bound) — so this can never send more than what remains.
 */
export function caseStepperIncrement(qty: number, ordered: number, unitsPerBox: number): number {
  if (unitsPerBox <= 0) return ordered;
  const caseCount = Math.floor(ordered / unitsPerBox);
  const casesDelivered = caseStepperCasesDelivered(qty, ordered, unitsPerBox);
  const next = casesDelivered < caseCount ? (casesDelivered + 1) * unitsPerBox : ordered;
  return Math.min(ordered, next);
}

/**
 * SA-175 review: the Case-stepper's own label, ALWAYS naming the Case count — even 0 — unlike
 * `@routeflow/pricing`'s `formatQtySplit` (which suppresses a zero box count, correct for its
 * other, non-stepper callers). "0 of 0" alone reads as "nothing to account for here"; "0 Cases +
 * 5 pcs" tells the driver there's still a genuine partial-Case remainder to short or refuse.
 */
export function formatCaseStepperSplit(
  boxes: number,
  pieces: number,
  boxLabel?: string | null,
): string {
  const singular = (boxLabel ?? "").trim() || "box";
  const plural = singular === "box" ? "boxes" : singular.endsWith("s") ? singular : `${singular}s`;
  const boxPart = `${boxes} ${boxes === 1 ? singular : plural}`;
  return pieces > 0 ? `${boxPart} + ${pieces} pcs` : boxPart;
}

/**
 * B648/SA-094a (SA-175 review, FLOOR-OR-PASS-THROUGH): the delivered qty this module ever uses
 * for a line. For a unit-aware line (`isUnitAwareLine`, factor > 1): a raw entry that already
 * reaches or exceeds `orderedQty` (the REMAINING qty on a second visit, per B785/SA-116 — not
 * always an exact multiple of `unitsPerBox`) passes through AS `orderedQty`, never floored —
 * that top value is the stepper's own genuine partial-Case step (`caseStepperIncrement`), and
 * flooring it silently dropped the remainder (30 left of a 12-Case floored to 24, stranding the
 * driver at a PARTIAL $48 instead of the true $60 due). Any value strictly BELOW `orderedQty`
 * still SNAPS DOWN to the nearest whole multiple of `unitsPerBox` —
 * `clamp(floor(raw / unitsPerBox) * unitsPerBox, 0, orderedQty)` — so a stray/leftover piece
 * count there (e.g. 300 on a 288-piece Case) can never leak a fractional Case into the money math.
 * n=0 -> REFUSED, n=orderedQty -> DELIVERED, anything between -> PARTIAL at that many WHOLE
 * cases (or the exact remainder at the top). No entry at all is the universal "untouched" default
 * every other line already uses: fully delivered. Every function below reads through this ONE
 * place — `normalizeDeliveryPlan` exports the same resolution for every caller that needs a full
 * plan map, not just one line's value (SA-094b's normalizer requirement: the category-tax half
 * and the review row's own badge must read the SAME resolved number reconciledTotal/
 * buildDeliveries already do).
 */
function effectiveDeliveredQty(
  li: Pick<
    ShortPickLine,
    "orderItemId" | "orderedQty" | "unitLabel" | "unitsPerBox" | "needsEntry"
  >,
  deliveredQtyById: Record<string, number>,
): number {
  const raw = deliveredQtyById[li.orderItemId];
  // SA-367a: no server `remaining` ⇒ no default. An untouched line counts 0 here (it bills nothing
  // in the estimate) and `buildDeliveries` refuses to build a payload until the driver enters it.
  if (li.needsEntry && raw == null) return 0;
  if (isUnitAwareLine(li)) {
    if (raw == null) return li.orderedQty;
    const clampedRaw = Math.max(0, raw);
    // SA-175 review fix (post-FIX-6): on a second visit `orderedQty` is the REMAINING qty, not
    // always an exact multiple of `unitsPerBox` — its own top state is a genuine partial Case
    // (caseStepperIncrement's last step lands exactly on it). Flooring FIRST, before checking
    // whether `raw` already reaches that top, silently dropped the partial-Case remainder: 30
    // left of a 12-Case floored to 24 (PARTIAL $48 of $60, never the untouched $60 full amount),
    // and 5 left of 12 floored to 0 (REFUSED $0, even though the driver never touched the row).
    // A raw value that already reaches (or exceeds) `orderedQty` must pass through AS the
    // remaining, never get floored down to the whole-Case boundary below it.
    if (clampedRaw >= li.orderedQty) return li.orderedQty;
    const upb = Number(li.unitsPerBox);
    const snapped = Math.floor(clampedRaw / upb) * upb;
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
    // SA-367a: an un-entered needsEntry line stays ABSENT — a resolved 0 here would read as the
    // driver's own "refused" once this map reaches buildStopDeliveries, bypassing its fail-closed
    // check. Every money reader treats it as 0 itself (effectiveDeliveredQty, shortPickCategoryTax).
    if (li.needsEntry && deliveredQtyById[li.orderItemId] == null) continue;
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
 *  `deliveredSoFar` projection, B785/SA-116). Absent/0 = a first visit. DISPLAY-ONLY (SA-367b):
 *  it prices the remaining money as the marginal tail; it never decides a quantity. */
export type DeliveredSoFarById = Readonly<Record<string, number>>;

/** orderItemId -> the server-computed `remaining` for THIS stop (SA-366: the same `lineRemaining`
 *  the completion bound accepts up to — 0 for a cancelled line or a line of a cancelled/draft
 *  order). A line ABSENT from the map had no `remaining` served (an older api): SA-367a. */
export type ServerRemainingById = Readonly<Record<string, number>>;

/**
 * SA-367a: flattens the run read's stop snapshot (`stop.orders[].lineItems[].remaining`) to a map —
 * the ONLY source of every quantity decision here (stepper default, Case ceiling, the "nothing
 * left" drop, the DELIVERED/PARTIAL type). A missing, null or non-finite value is left OUT (not
 * 0, not qty), so the line falls to `needsEntry`.
 */
export function remainingByLine(
  stopOrders:
    | readonly {
        lineItems?: readonly { id: string; remaining?: number | string | null }[] | null;
      }[]
    | null
    | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of stopOrders ?? []) {
    for (const li of o.lineItems ?? []) {
      if (li.remaining == null) continue;
      const n = Number(li.remaining);
      if (Number.isFinite(n)) out[li.id] = Math.max(0, n);
    }
  }
  return out;
}

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
 * B785/SA-116 + SA-367a: whether the review screen offers a line at all. With a server `remaining`
 * the line is offered exactly while something remains (`remaining > 0` — which also drops a
 * cancelled line, or a line of a cancelled/draft order, whose served remaining is 0). With NO
 * `remaining` served (an older api) the pre-B785 rule holds: not cancelled and nothing delivered
 * yet. The client never computes `qty − deliveredSoFar` to decide this.
 */
export function isLineAdjustable(
  li: { status?: string | null; qty: number | string; deliveredQty?: number | string | null },
  remaining?: number,
): boolean {
  if (li.status === "CANCELLED") return false;
  if (remaining !== undefined) return remaining > 0;
  return Number(li.deliveredQty ?? 0) === 0;
}

/**
 * B785/SA-116 + SA-367a: the PER-VISIT view of a line — what THIS visit can still deliver. Every
 * QUANTITY comes from the server's `remaining`: the ordered qty (so the stepper default, the
 * DELIVERED/PARTIAL type and the default explicit entry) and a unit-aware line's Case ceiling
 * (`floor(remaining / unitsPerBox)` plus the true remainder). `soFar` only prices the remaining
 * money (FIX 7, display-only per SA-367b; the server bills from its own reader on close). No
 * `remaining` served ⇒ `needsEntry`: no default at all, `orderedQty` = the line's qty as a ceiling.
 */
function visitView(li: ShortPickSourceLine, remaining: number | undefined, soFar: number) {
  const qty = Number(li.qty);
  const freeUnitSize = freeUnitSizeFor(li);
  const upb = Number(li.unitsPerBox ?? 0);
  const hasSplit = li.boxes != null && upb > 0;
  if (remaining === undefined || !(soFar > 0)) {
    // A first visit (nothing delivered elsewhere) or no served remaining: the stored split and the
    // full agreed money. `orderedQty` is the served remaining when there is one (it equals qty on
    // a first visit), else qty as the needsEntry ceiling.
    const ordered = remaining ?? qty;
    const boxes = hasSplit && ordered !== qty ? Math.floor(ordered / upb) : (li.boxes ?? null);
    return {
      orderedQty: ordered,
      subtotal: li.subtotal ?? null,
      freeUnits: li.promoFreeUnits ?? 0,
      freeUnitSize,
      boxes,
      pieces: hasSplit ? ordered - Number(boxes) * upb : null,
      ...(remaining === undefined ? { needsEntry: true } : {}),
    };
  }
  // FIX 6 (SA-175): FLOOR, never round — a rounded-up Case count can bound the stepper's top
  // above what actually remains (30 left of a 12-Case rounds to "3 of 3" = 36, over-delivering).
  // FIX 7 (SA-175): the remaining money is the CUMULATIVE telescope's tail, not a fresh proration
  // of the front `remaining` pieces — prorateLineSubtotal's promo/BOGO curve is non-linear, so
  // "price(qty) − price(soFar)" (the true marginal price of the pieces beyond soFar) can differ
  // from "price(remaining)" (which silently re-prices the first `remaining` pieces as if THEY
  // were the ones still owed, wrong the moment a free unit lands on one side of that split and
  // not the other). This exactly matches the server's own paid-basis formula.
  const boxes = hasSplit ? Math.floor(remaining / upb) : (li.boxes ?? null);
  return {
    orderedQty: remaining,
    subtotal:
      li.subtotal == null
        ? null
        : // SA-175 review (W/N): both operands are already roundMoney'd inside
          // prorateLineSubtotal, but their JS-float subtraction can still land a cent off
          // (e.g. 0.1 − 0.03 → 0.06999999999999999) — round the tail itself too.
          roundMoney(
            prorateLineSubtotal(li.subtotal, qty, qty, li.promoFreeUnits ?? 0, freeUnitSize) -
              prorateLineSubtotal(li.subtotal, soFar, qty, li.promoFreeUnits ?? 0, freeUnitSize),
          ),
    freeUnits: 0, // already netted out of the prorated subtotal above
    freeUnitSize: 1,
    boxes,
    pieces: hasSplit ? remaining - (boxes as number) * upb : null,
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
 * re-offer an already-settled line). B785/SA-367a: a line is offered at the
 * server's `remaining` (`remainingById`, off the stop's run snapshot); a line
 * with no served remaining is offered with an EMPTY stepper (`needsEntry`).
 */
export function shortPickLinesFromOrder(
  order: { lineItems?: readonly ShortPickSourceLine[] | null } | null | undefined,
  remainingById: ServerRemainingById,
  soFarById: DeliveredSoFarById = {},
): ShortPickLine[] {
  return (order?.lineItems ?? [])
    .filter((li) => isLineAdjustable(li, remainingById[li.id]))
    .map((li) => ({
      orderItemId: li.id,
      productId: li.productId,
      ...visitView(li, remainingById[li.id], soFarById[li.id] ?? 0),
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
  /** B785/SA-116: pieces delivered at OTHER visits (run read projection) — display money only. */
  deliveredSoFar?: number | string | null;
  /** SA-366/SA-367a: the server-computed remaining for this stop — every quantity decision. */
  remaining?: number | string | null;
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
  // SA-367a: the snapshot IS the run read, so it carries the server's `remaining` itself.
  const remainingById = remainingByLine([order ?? {}]);
  return (
    (order?.lineItems ?? [])
      // B785/SA-116 + SA-367a: a later visit's fallback entry is the server's REMAINING, never a
      // re-claim of the full order (closes the SA-115 residual below); a line with nothing
      // remaining (including a cancelled line/order, served 0) is dropped rather than re-sent.
      .filter((li) => li.status !== "CANCELLED" && (remainingById[li.id] ?? 1) > 0)
      .map((li) => {
        const qty = Number(li.qty ?? 0);
        const served = remainingById[li.id];
        const ordered = served ?? qty;
        const partial = served !== undefined && served !== qty;
        const upb = Number(li.unitsPerBox ?? 0);
        const hasSplit = li.boxes != null && upb > 0;
        // FIX 6 (SA-175): FLOOR, never round (see visitView's twin comment) — no promo data
        // rides this snapshot (freeUnits/freeUnitSize stay 0/1 below), so unlike visitView the
        // linear front-slice proration here is already exact; only the Case-count rounding needs
        // the same fix.
        const boxes = hasSplit ? (partial ? Math.floor(ordered / upb) : Number(li.boxes)) : null;
        return {
          orderItemId: li.id,
          productId: li.productId,
          orderedQty: ordered,
          subtotal:
            li.subtotal == null
              ? null
              : partial
                ? prorateLineSubtotal(Number(li.subtotal), ordered, qty, 0, 1)
                : Number(li.subtotal),
          freeUnits: 0,
          freeUnitSize: 1,
          // B648/SA-094 (carried through the B762 merge) — see StopSnapshotLine.
          unitLabel: li.unitLabel ?? null,
          unitsPerBox: li.unitsPerBox ?? null,
          boxes: hasSplit ? boxes : (li.boxes ?? null),
          pieces: hasSplit ? ordered - (boxes as number) * upb : null,
          // SA-367a: no served remaining ⇒ no default — this close cannot proceed until the driver
          // enters the line on the review screen (`linesAwaitingEntry`).
          ...(served === undefined ? { needsEntry: true } : {}),
        };
      })
  );
}

/**
 * #2300: a LATER visit — the server served a `remaining` below `qty` on at least one active line
 * (#1353 caps a re-delivery to what is left). A line with no served remaining says nothing either way.
 */
export function isLaterVisit(
  order: { lineItems?: readonly StopSnapshotLine[] | null } | null | undefined,
): boolean {
  const remainingById = remainingByLine([order ?? {}]);
  return (order?.lineItems ?? []).some((li) => {
    const served = remainingById[li.id];
    return li.status !== "CANCELLED" && served !== undefined && served < Number(li.qty ?? 0);
  });
}

/**
 * #2300: the lines the payment screen's door QUOTE prices for one order. Its landed rich lines when
 * it has any; while its per-order fetch hasn't landed on a later visit, the stop snapshot's own
 * remaining-based fallback lines — never the full order total, which overstates what is owed.
 * `[]` means "price the whole order" (a first visit, or a landed order with nothing adjustable),
 * exactly as before. Display/cap only: the close payload keeps its own line choice.
 */
export function doorQuoteLines(
  order: { lineItems?: readonly StopSnapshotLine[] | null } | null | undefined,
  richLines: readonly ShortPickLine[],
  landed: boolean,
): ShortPickLine[] {
  if (richLines.length > 0) return [...richLines];
  if (landed || !isLaterVisit(order)) return [];
  return fallbackShortPickLines(order);
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
  // SA-367a: fail closed — a line with no served remaining and no driver entry has NO honest
  // default (neither the full qty nor 0/REFUSED), so no payload may be built until it is entered.
  // Both screens gate on `linesAwaitingEntry` first; this is the backstop.
  const awaiting = linesAwaitingEntry(lines, deliveredQtyById);
  if (awaiting.length > 0) {
    throw new Error(`Enter the delivered quantity for ${awaiting.length} line(s) before closing.`);
  }
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

/**
 * SA-367a: the ids of lines the driver still has to enter — lines served no `remaining`
 * (`needsEntry`) with no entry in `deliveredQtyById`. Non-empty ⇒ the review screen's Continue
 * and the payment screen's close are blocked, and `buildDeliveries` throws.
 */
export function linesAwaitingEntry(
  lines: readonly Pick<ShortPickLine, "orderItemId" | "needsEntry">[],
  deliveredQtyById: Record<string, number>,
): string[] {
  return lines
    .filter((li) => li.needsEntry && deliveredQtyById[li.orderItemId] == null)
    .map((li) => li.orderItemId);
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
