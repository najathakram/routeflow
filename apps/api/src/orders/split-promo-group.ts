import {
  allocateFreeUnits,
  linePromoUnits,
  normalizeBoxesPieces,
  productPromotionQty,
  type ProductPromotionQty,
} from "@routeflow/pricing";
import { piecesDenominated } from "./buyer-edit-lines";

/**
 * B297 row 355 (SA-734r2 r-note 5): the buyer replace-all prices a product that sits on SEVERAL lines of the
 * order (a rate-trio split, a pack line beside a box-split line) on the product's COMBINED quantity, never on
 * each line's own. Price promotions (QTY_BREAK / PERCENT / FIXED) then resolve once and every line of the
 * product bills the same net price; BUY_N_GET_M free units are measured on the combined whole units and
 * allocated oldest line first, capped at each line's units, with `promoFreeUnits` still per line.
 *
 * A product on ONE line is untouched (`plan` returns no group for it), so single-line pricing is byte-identical.
 */
export interface SplitPromoGroup {
  qtyPieces: number;
  qtyUnits: number;
  denomination: { boxes: number | null; pieces: number | null; unitsPerBox: number | null };
  /** This entry's share of the product's `totalFree` free units (allocated once, on first ask). */
  share(item: object, totalFree: number): number;
}

interface PlanItem {
  productId?: string | null;
  qty?: number;
  boxes?: number | null;
  pieces?: number | null;
  sourceLineId?: string;
}

export function planSplitPromos(
  items: ReadonlyArray<PlanItem>,
  lineItems: ReadonlyArray<{
    id?: string | null;
    productId?: string | null;
    boxes?: unknown;
    pieces?: unknown;
  }>,
  productMap: ReadonlyMap<string, { unitsPerBox?: unknown }>,
  pieceDenominated: ReadonlySet<string>,
): Map<string, SplitPromoGroup> {
  const byProduct = new Map<string, PlanItem[]>();
  for (const it of items) {
    if (!it.productId || !it.qty) continue;
    byProduct.set(it.productId, [...(byProduct.get(it.productId) ?? []), it]);
  }
  const out = new Map<string, SplitPromoGroup>();
  for (const [productId, entries] of byProduct) {
    const upb = Number(productMap.get(productId)?.unitsPerBox ?? 0);
    if (entries.length < 2 || !productMap.has(productId)) continue;
    // Oldest first = payload order: the write loop re-creates every line in this order (equal createdAt, so
    // `position` decides), and the resolver puts a split's stored half before its added half. A later settle
    // reads (createdAt, position, id), so the allocation is stable across writers.
    const ordered = [...entries];
    // Each entry as the write loop will store it (the same per-line pieces-or-units decision).
    const shaped = ordered.map((it) => {
      const split =
        upb > 1 && piecesDenominated(lineItems, it, pieceDenominated, true)
          ? normalizeBoxesPieces({ qty: Number(it.qty), unitsPerBox: upb })
          : null;
      return split
        ? { qty: split.qty, boxes: split.boxes, pieces: split.pieces }
        : { qty: Number(it.qty), boxes: null, pieces: null };
    });
    const combined: ProductPromotionQty = productPromotionQty(shaped, upb);
    const caps = shaped.map((l) => linePromoUnits(l, upb));
    let shares: number[] | null = null;
    const indexOf = new Map<object, number>(ordered.map((it, i) => [it, i]));
    out.set(productId, {
      qtyPieces: combined.qtyPieces,
      qtyUnits: combined.qtyUnits,
      denomination: {
        boxes: combined.boxes,
        pieces: combined.pieces,
        unitsPerBox: combined.unitsPerBox,
      },
      share(item, totalFree) {
        const alloc = (shares ??= allocateFreeUnits(totalFree, caps));
        return alloc[indexOf.get(item) ?? 0] ?? 0;
      },
    });
  }
  return out;
}
