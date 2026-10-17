import { computeLineSubtotal, effectiveQty } from "@routeflow/pricing";
import { draftFreeUnits, type DraftItem, type UnlistedDraft } from "./edit-items-draft";

/**
 * The order editor's footer total (extracted verbatim from edit-items.tsx's `total` memo, size-ratchet): every staged
 * catalog line and unlisted line through computeLineSubtotal.
 */
export function draftTotal(draft: Record<string, DraftItem>, unlisted: UnlistedDraft[]): number {
  let t = 0;
  for (const it of Object.values(draft)) {
    const qty = effectiveQty(it, it.unitsPerBox);
    if (qty <= 0) continue;
    t += computeLineSubtotal({
      unitPrice: it.unitPrice,
      qty,
      boxes: it.boxes ?? null,
      pieces: it.pieces ?? null,
      unitsPerBox: it.unitsPerBox ?? null,
      // BUY_N_GET_M: free whole units come off before pricing, exactly like
      // the server — otherwise the preview bills an agreed 12-boxes-2-free
      // line at full price and disagrees with what the save writes back.
      freeUnits: draftFreeUnits(it),
    });
  }
  for (const u of unlisted) {
    if (u.qty <= 0) continue;
    t += computeLineSubtotal({ unitPrice: u.unitPrice, qty: u.qty });
  }
  return t;
}
