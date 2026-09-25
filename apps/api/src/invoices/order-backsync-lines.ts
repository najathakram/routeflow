import { normalizeBoxesPieces } from "@routeflow/pricing";

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
  verbatim: boolean,
): {
  qty: number;
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  unitLabel?: string | null;
} {
  const sample = agg.sample;
  if (verbatim) {
    return {
      qty: agg.qty,
      boxes: sample?.boxes ?? null,
      pieces: sample?.pieces ?? null,
      unitsPerBox: sample?.unitsPerBox ?? null,
      unitLabel: sample?.unitLabel ?? null,
    };
  }
  // Several invoice lines feed this order line: the old re-split applies only when EVERY one of them shares a
  // known pack > 1, and it is THAT pack (an attested re-pack is not written back at the order line's old pack).
  // Otherwise the pack is unknown and the stored split is kept, as for a legacy line.
  const multi = (agg.n ?? 1) > 1;
  const shared = agg.packs?.size === 1 ? [...agg.packs][0] : 0;
  const upb = multi
    ? shared > 1
      ? shared
      : 0
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

/** Which back-sync target (`line:<orderItemId>` or `product:<id>`) an invoice line feeds. */
export function backSyncTargetKey(
  it: { orderItemId?: string | null; productId?: string | null },
  byId: ReadonlyMap<string, any>,
  byProduct: ReadonlyMap<string, any>,
): string | null {
  const line =
    (it.orderItemId && byId.get(it.orderItemId)) ||
    (it.productId && byProduct.get(it.productId)) ||
    null;
  return line ? `line:${line.id}` : it.productId ? `product:${it.productId}` : null;
}
