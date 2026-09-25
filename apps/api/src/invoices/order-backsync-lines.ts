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
  agg: { qty: number; sample: any; n?: number },
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
  const upb = Number(existing?.unitsPerBox ?? sample?.unitsPerBox ?? 0);
  const isBoxSplit = (existing ?? sample)?.boxes != null;
  // A box-split line whose pack is unknown (a legacy 0-box + 5-piece line) cannot be re-split from qty:
  // normalizing at pack 0 would turn its stored 0 into null and flip it to box-unaware. Keep the stored
  // split (the single billed invoice line's when there is one), 0 stays 0.
  if (isBoxSplit && !(upb > 1)) {
    const src = agg.n === 1 ? sample : (existing ?? sample);
    return {
      qty: agg.qty,
      boxes: src?.boxes ?? null,
      pieces: src?.pieces ?? null,
      unitsPerBox: null,
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
