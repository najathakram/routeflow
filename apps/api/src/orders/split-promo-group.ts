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
    // Oldest first, as a later settle reads it: lines paired with a STORED line by `sourceLineId` first, by
    // that line's (createdAt, position, id) (the re-created line carries its createdAt, r-note 7), then the
    // lines added in this edit in payload order (they get a later createdAt and a later position).
    const stored = new Map(lineItems.filter((l) => l.id).map((l) => [l.id as string, l as any]));
    const key = (it: PlanItem) => {
      const l = it.sourceLineId ? stored.get(it.sourceLineId) : undefined;
      return l
        ? ([
            0,
            l.createdAt ? new Date(l.createdAt).getTime() : 0,
            l.position ?? 0,
            String(l.id),
          ] as const)
        : null;
    };
    const ordered = entries
      .map((it, i) => ({ it, i, k: key(it) }))
      .sort((a, b) => {
        if (a.k && b.k) {
          return (
            a.k[1] - b.k[1] || a.k[2] - b.k[2] || (a.k[3] < b.k[3] ? -1 : a.k[3] > b.k[3] ? 1 : 0)
          );
        }
        if (a.k) return -1;
        if (b.k) return 1;
        return a.i - b.i;
      })
      .map((x) => x.it);
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
