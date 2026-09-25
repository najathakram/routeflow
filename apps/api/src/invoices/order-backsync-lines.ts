import { normalizeBoxesPieces, roundMoney } from "@routeflow/pricing";

/**
 * The denomination an order line is written with by the invoice -> order back-sync.
 *
 * SA-203(c): when the line is written because ONE invoice line changed, the order line takes that
 * invoice line's stored boxes / pieces / unitsPerBox / unitLabel VERBATIM (never a split re-derived
 * from the product or from qty). Any other write keeps the long-standing rule: the order line's own
 * denomination, re-split from the billed qty, and never the live product.
 */
export function orderLineShape(
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
  // SA-225: ONE billed invoice line is copied verbatim (split, pack, label) in every recompute mode, so a
  // non-normalized split (1 box + 14 pieces) is never re-derived. Only a split-less invoice line over a
  // split order line falls through (it must not blank the order line's split); n > 1 keeps the shared-pack rule.
  const verbatim = agg.n === 1 && !(sample?.boxes == null && existing?.boxes != null);
  if (verbatim) {
    return {
      qty: agg.qty,
      boxes: sample?.boxes ?? null,
      pieces: sample?.pieces ?? null,
      unitsPerBox: sample?.unitsPerBox ?? null,
      // the label is written from a single billed line that HAS one, otherwise the order line's is kept
      ...(sample?.unitLabel != null ? { unitLabel: sample.unitLabel } : {}),
    };
  }
  // Several invoice lines feed this order line: the old re-split applies only when EVERY one of them shares a
  // known pack > 1, and it is THAT pack (an attested re-pack is not written back at the order line's old pack).
  // Otherwise the pack is unknown and the stored split is kept, as for a legacy line.
  const multi = (agg.n ?? 1) > 1;
  const shared = agg.packs?.size === 1 ? [...agg.packs][0] : 0;
  // With no shared pack the ORDER line's own known pack still stands (never a sibling's, never the live product's).
  const upb = multi
    ? shared > 1
      ? shared
      : Number(existing?.unitsPerBox ?? 0)
    : Number(existing?.unitsPerBox ?? sample?.unitsPerBox ?? 0);
  const isBoxSplit = (existing ?? sample)?.boxes != null;
  // A box-split line whose pack is unknown (a legacy 0-box + 5-piece line) cannot be re-split from qty:
  // normalizing at pack <= 1 would turn its stored 0 into null and flip it to box-unaware. Keep the stored
  // split: the single billed invoice line's, but ONLY when that line has a split of its own (a line with
  // none must not blank the order line's); otherwise the order line's own. With 0 boxes the pieces ARE
  // the qty, so a qty change stays consistent (0 boxes + 6 pieces, never 0 + 5 for qty 6). A stored pack
  // of exactly 1 is kept as 1, as before; only 0/unknown becomes null.
  if (isBoxSplit && !(upb > 1)) {
    const src = agg.n === 1 && sample?.boxes != null ? sample : (existing ?? sample);
    const boxes = src?.boxes ?? null;
    return {
      qty: agg.qty,
      boxes,
      pieces: boxes === 0 ? agg.qty : (src?.pieces ?? null),
      unitsPerBox: upb > 0 ? upb : multi ? (existing?.unitsPerBox ?? null) : null,
    };
  }
  const split = isBoxSplit
    ? normalizeBoxesPieces({ qty: agg.qty, unitsPerBox: upb })
    : { qty: agg.qty, boxes: null as number | null, pieces: null as number | null };
  return { ...split, unitsPerBox: upb > 0 ? upb : null };
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
): boolean {
  const freeUnits = Math.max(0, Math.trunc(agg.freeUnits) || 0);
  // [column, value] pairs (a comparison, not a write: no object literal keyed by the levy column).
  const want: Array<[string, unknown]> = [
    ["qty", shape.qty],
    ["boxes", shape.boxes],
    ["pieces", shape.pieces],
    ["unitsPerBox", shape.unitsPerBox],
    ["unitPrice", agg.unitPrice],
    ["subtotal", roundMoney(agg.subtotal)],
    ["categoryTaxAmount", roundMoney(agg.categoryTax)],
    ["promoFreeUnits", freeUnits > 0 ? freeUnits : null],
    ["invoicedQty", shape.qty],
    ["status", "PENDING"],
    ...(shape.unitLabel !== undefined
      ? [["unitLabel", shape.unitLabel ?? null] as [string, unknown]]
      : []),
  ];
  return want.every(([k, v]) => sameValue(existing[k], v));
}

/** Does `row` already hold every `[column, value]` pair? Then writing them again would change nothing. */
export const holdsValues = (row: any, want: ReadonlyArray<readonly [string, unknown]>): boolean =>
  want.every(([k, v]) => sameValue(row?.[k], v));
