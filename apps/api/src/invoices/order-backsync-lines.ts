import { normalizeBoxesPieces, roundMoney, splitMatchesQty } from "@routeflow/pricing";
import { finiteStoredMoney } from "../common/money-invariants.util";
import { assertUnitLineSplit } from "../orders/unit-line-split";

/**
 * The denomination (qty, boxes, pieces, pack, unit label) an order line is written with by the invoice ->
 * order back-sync. It runs on EVERY recompute (SA-233/235; identical results are then not written), so it may
 * never re-derive a split from qty or the live product for a line whose figures did not change:
 *  - ONE billed invoice line WITH a split (n === 1): its split, pack and label are copied VERBATIM (SA-225);
 *    a legacy line with no pack does not blank the order line's own pack.
 *  - ONE billed line WITHOUT a split over a split order line (SA-227): the order line's own split and pack are
 *    KEPT (never re-normalized, so 1 box + 14 pieces stays 1 + 14); only a moved qty re-splits, at its own pack.
 *  - A line whose figures do not change is never re-derived; a no-split invoice line billing a no-split order line
 *    leaves it box-unaware and keeps the order line's own pack (as master did).
 *  - INVARIANT (SA-257): any split written satisfies boxes x pack + pieces === qty. A copied or kept split that
 *    would not (a legacy 1 + 0 line with no pack over an order line at pack 12; a stored 1 + 14 re-billed at a
 *    different pack) is re-split at the resolved pack; with no known pack, 0 boxes => pieces = qty.
 *  - SEVERAL billed lines (n > 1): the old re-split, at the pack they all share (SA-233), else the order line's
 *    own known pack; a pack that is unknown keeps the stored split (0 boxes => pieces = qty).
 */
export function orderLineShape(
  existing: any,
  agg: { qty: number; sample: any; n?: number; packs?: ReadonlySet<number> },
): ReturnType<typeof rawShape> {
  const shape = consistentSplit(rawShape(existing, agg), agg.qty);
  // #2230 / SA-388d: never mirror B718's all-empty split back onto the order line.
  const unitLabel = shape.unitLabel !== undefined ? shape.unitLabel : (existing?.unitLabel ?? null);
  // #2230 / SA-388i: the writer passes what it holds, to name the line and its id in the 409 / Sentry.
  const named = {
    id: existing?.id,
    productId: existing?.productId ?? agg.sample?.productId,
    description: agg.sample?.description ?? existing?.name,
  };
  return assertUnitLineSplit({ ...shape, unitLabel, ...named }, "orderLineShape") && shape;
}

function rawShape(
  existing: any,
  agg: { qty: number; sample: any; n?: number; packs?: ReadonlySet<number> },
): {
  qty: number;
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  unitLabel?: string | null;
} {
  const sample = agg.sample;
  const single = agg.n === 1;
  if (single && sample?.boxes != null) {
    return {
      qty: agg.qty,
      boxes: sample.boxes,
      pieces: sample.pieces ?? null,
      // a legacy billed line with no pack must not blank the order line's own (master kept it)
      unitsPerBox: sample.unitsPerBox ?? existing?.unitsPerBox ?? null,
      // the label is written from a single billed line that HAS one, otherwise the order line's is kept
      ...(sample.unitLabel != null ? { unitLabel: sample.unitLabel } : {}),
    };
  }
  const shared = agg.packs?.size === 1 ? [...agg.packs][0] : 0;
  const upb =
    (agg.n ?? 1) > 1
      ? shared > 1
        ? shared
        : Number(existing?.unitsPerBox ?? 0)
      : Number(existing?.unitsPerBox ?? sample?.unitsPerBox ?? 0);
  const held = existing ?? sample;
  if (held?.boxes == null)
    return { qty: agg.qty, boxes: null, pieces: null, unitsPerBox: upb > 0 ? upb : null };
  // Unchanged qty over a stored split at a known pack: keep the split exactly as stored (no re-normalizing).
  if (single && Number(existing?.unitsPerBox) > 1 && Number(existing?.qty) === agg.qty) {
    return {
      qty: agg.qty,
      boxes: existing.boxes,
      pieces: existing.pieces ?? null,
      unitsPerBox: upb,
    };
  }
  if (!(upb > 1)) {
    // Pack unknown: normalizing at pack <= 1 would turn a stored 0 into null (box-unaware). Keep the stored
    // split; with 0 boxes the pieces ARE the qty. A stored pack of exactly 1 stays 1; only 0/unknown is null.
    return {
      qty: agg.qty,
      boxes: held.boxes,
      pieces: held.boxes === 0 ? agg.qty : (held.pieces ?? null),
      unitsPerBox: upb > 0 ? upb : null,
    };
  }
  return { ...normalizeBoxesPieces({ qty: agg.qty, unitsPerBox: upb }), unitsPerBox: upb };
}

export const sameValue = (a: unknown, b: unknown): boolean =>
  a == null || b == null
    ? a == null && b == null
    : typeof b === "number"
      ? Math.abs(Number(a) - b) < 1e-9
      : a === b;

/**
 * Would the back-sync write this order line back exactly as it already is? Then the write is skipped: a save
 * that changes no order line (an edit of the invoice discount or shipping, a re-price that lands on the same
 * figures) leaves the order's rows, and their updatedAt, untouched (SA-203), while a line that DOES differ
 * (a short-delivered line shrinking to its billed qty, a refused one being covered) is still written.
 * Compares exactly the columns the update below writes.
 */
export function orderLineUnchanged(
  existing: any,
  shape: {
    qty: number;
    boxes: number | null;
    pieces: number | null;
    unitsPerBox: number | null;
    unitLabel?: string | null;
  },
  agg: { unitPrice: number; subtotal: number; categoryTax: number; freeUnits: number },
  /** Columns left out of the comparison (row 372: `invoicedQty` / the levy are bookkeeping, not the sale). */
  ignore: ReadonlyArray<string> = [],
): boolean {
  const freeUnits = Math.max(0, Math.trunc(agg.freeUnits) || 0);
  // [column, value] pairs (a comparison, not a write: no object literal keyed by the levy column).
  const want: Array<[string, unknown]> = [
    ["qty", shape.qty],
    ["boxes", shape.boxes],
    ["pieces", shape.pieces],
    ["unitsPerBox", shape.unitsPerBox],
    // SA-816b: a non-finite aggregate must not read as 0 (equal to a stored 0, so the line looked unchanged).
    ["unitPrice", finiteStoredMoney(agg.unitPrice, "The order line unit price")],
    ["subtotal", roundMoney(finiteStoredMoney(agg.subtotal, "The order line subtotal"))],
    [
      "categoryTaxAmount",
      roundMoney(finiteStoredMoney(agg.categoryTax, "The order line category tax")),
    ],
    ["promoFreeUnits", freeUnits > 0 ? freeUnits : null],
    ["invoicedQty", shape.qty],
    ["status", "PENDING"],
    ...(shape.unitLabel !== undefined
      ? [["unitLabel", shape.unitLabel ?? null] as [string, unknown]]
      : []),
  ];
  return want.every(([k, v]) => ignore.includes(k) || sameValue(existing[k], v));
}

/** Row 372: the columns whose rewrite is bookkeeping, never a change to what the order sells. */
export const SALE_NEUTRAL_COLUMNS = ["invoicedQty", "categoryTaxAmount"] as const;

/** Does `row` already hold every `[column, value]` pair? Then writing them again would change nothing. */
export const holdsValues = (row: any, want: ReadonlyArray<readonly [string, unknown]>): boolean =>
  want.every(([k, v]) => sameValue(row?.[k], v));

/**
 * The invariant (SA-257): a split carrying a pack > 1 must satisfy `splitMatchesQty` (the ONE definition, shared
 * with the invoice edit plan); if it does not, it is re-split at THAT pack. A shape with no known pack
 * (null, 0 or 1) is never given one from elsewhere: it is left as chosen (stored split kept, SA-211).
 */
function consistentSplit<
  T extends {
    qty: number;
    boxes: number | null;
    pieces: number | null;
    unitsPerBox: number | null;
  },
>(shape: T, qty: number): T {
  const upb = Number(shape.unitsPerBox ?? 0);
  if (shape.boxes == null || !(upb > 1)) return shape;
  if (splitMatchesQty({ qty, boxes: shape.boxes, pieces: shape.pieces, unitsPerBox: upb }))
    return shape;
  return { ...shape, ...normalizeBoxesPieces({ qty, unitsPerBox: upb }), unitsPerBox: upb };
}
