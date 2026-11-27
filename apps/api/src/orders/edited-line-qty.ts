import { normalizeBoxesPieces } from "@routeflow/pricing";
import { packForLineEdit, storedLineEditShape } from "./live-pack-map";

/**
 * SA-1506 PR-1 prefactor (SA-065 class, behaviour-neutral): the per-line quantity + box/piece split resolution of
 * `updateOrderItems`' merge branch, lifted VERBATIM out of `orders.service.ts` (its file sat one line under its
 * size ratchet). The caller keeps the `qty <= 0` skip and the quantity floor, which read the result.
 *
 * Resolves qty + the box/piece split of an EXISTING catalog line, PRESERVING its denomination:
 *  - an explicit boxes/pieces edit wins;
 *  - else a box-split line re-derives its split from the new qty (box price prorated, stale boxes/pieces refreshed);
 *  - else a selling-unit / non-boxed line keeps boxes/pieces null.
 * The box size is resolved for a catalog line even on a qty-ONLY edit. A STORED split line reads the pack it was sold
 * in, never today's product pack; one that can't be read is refused (SA-1097, L-332).
 */
export async function resolveEditedLineQty(
  tx: Parameters<typeof packForLineEdit>[0],
  li: Parameters<typeof packForLineEdit>[1] & { qty: unknown },
  item: { qty?: number | null; boxes?: number | null; pieces?: number | null },
  warnSplit: (upb: number) => void,
): Promise<{ qty: number; boxes: number | null; pieces: number | null; upb: number }> {
  // A zero boxes+pieces payload is "not using box entry", not "zero quantity" (see create()): a POSITIVE check keeps
  // it from silently discarding a real item.qty typed alongside it (the split branch ignores item.qty entirely).
  const editHasSplit = (item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0;
  const wasBoxSplit = li.boxes != null || li.pieces != null;
  const { pack: unitsPerBox, soldWithNoPack, stored } = await packForLineEdit(tx, li, editHasSplit);
  const upb = Number(unitsPerBox ?? 0);
  if (stored) {
    // SA-1097: a stored split line is edited at the pack it was sold in, never today's (live-pack-map.ts).
    return { ...storedLineEditShape(item, li.qty, unitsPerBox, soldWithNoPack), upb };
  }
  if (editHasSplit) {
    warnSplit(upb);
    const split = normalizeBoxesPieces({
      boxes: item.boxes,
      pieces: item.pieces,
      qty: item.qty ?? Number(li.qty),
      unitsPerBox: upb,
    });
    return { qty: split.qty, boxes: split.boxes, pieces: split.pieces, upb };
  }
  if (wasBoxSplit && upb > 1) {
    const split = normalizeBoxesPieces({ qty: item.qty ?? Number(li.qty), unitsPerBox: upb });
    return { qty: split.qty, boxes: split.boxes, pieces: split.pieces, upb };
  }
  return { qty: item.qty ?? Number(li.qty), boxes: null, pieces: null, upb };
}
