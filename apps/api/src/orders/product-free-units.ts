import { PriceType } from "@prisma/client";
import {
  allocateFreeUnits,
  computeLineSubtotal,
  linePromoUnits,
  productPromotionQty,
  type PromotionRule,
} from "@routeflow/pricing";
import { isBuyerPricedLine, rescaleBogoFreeUnits } from "./buyer-merge-pricing";

/**
 * B297 row 355 (SA-734r2 r-note 5 + 6): THE one place a product that sits on several lines of one order gets
 * its BUY_N_GET_M free units. The combined whole-unit count is measured once (`productPromotionQty`), the
 * free units that count earns are decided once (`rescaleBogoFreeUnits`: the live rule, else the earned
 * snapshot, never an entirely free product), and they are allocated across the lines oldest first, capped at
 * each line's units (`allocateFreeUnits`). `promoFreeUnits` stays per line. Every writer that carries a
 * non-empty `promos:` list (the merge, force-consolidate, the stored-price qty edit, the DRIVER edit) comes
 * through here, so a split pair earns what one line of the same size would.
 *
 * Pure. A product on ONE line, a line with an operator price or a price promotion, a product whose lines sit
 * at different packs, and an empty `promos` list are all returned untouched: those cases stay byte-identical.
 */
export interface FreeUnitLine {
  /** Caller's handle, echoed in the result. */
  key: string;
  productId: string;
  qty: number;
  boxes: number | null;
  pieces: number | null;
  /** The pack snapshot on the line; 0 when it carries none. */
  pack: number;
  unitPrice: number;
  /** The line's CURRENT promoFreeUnits (0 when none). */
  free: number;
  priceType: PriceType | null;
  originalPrice: number | null;
  overriddenBy: string | null;
  /** A unit-aware line (Case, Piece, ...): never promoted (units_v1), and never counted as a pack. */
  unitLabel?: string | null;
}

/** What the order held for one product BEFORE this edit: the licence to re-measure what it had earned. */
export interface FreeUnitBaseline {
  /** Σ promoFreeUnits over the product's live lines before the edit. */
  free: number;
  /** Σ whole selling units over those lines before the edit. */
  units: number;
  /** How many live lines of the product it had. */
  lines: number;
}

export interface FreeUnitOptions {
  promos: ReadonlyArray<PromotionRule>;
  /** A buyer-driven merge may earn units no line had; every other writer only re-measures what was earned. */
  canEarnNew: boolean;
  categoryFor: (productId: string) => string | null;
  /** The live pack, for a box-split legacy line that never snapshotted its own. */
  liveUnitsPerBoxFor?: (productId: string) => number;
  /**
   * The pre-edit state per product. With it a product that WAS split is re-measured even when the edit left
   * one line (a sibling short-picked to 0 / cancelled), and the units it had earned are the licence, not the
   * post-edit snapshot sum (a per-line rescale may already have zeroed the line that held them).
   */
  baseline?: ReadonlyMap<string, FreeUnitBaseline>;
}

export interface FreeUnitChange {
  key: string;
  free: number;
  subtotal: number;
}

/** `lines` must already be OLDEST FIRST within each product. Returns only the lines whose free units change. */
export function reallocateFreeUnits(
  lines: ReadonlyArray<FreeUnitLine>,
  opts: FreeUnitOptions,
): FreeUnitChange[] {
  if (opts.promos.length === 0) return [];
  const byProduct = new Map<string, FreeUnitLine[]>();
  for (const l of lines) byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), l]);

  const out: FreeUnitChange[] = [];
  for (const [productId, group] of byProduct) {
    const base = opts.baseline?.get(productId);
    if (group.length < 2 && !(base && base.lines >= 2)) continue;
    // units_v1: a unit-aware line is never promoted and its count is not packs (its snapshot of 1 would
    // otherwise be dropped and the group read as whole boxes).
    if (group.some((l) => l.unitLabel != null && l.unitLabel !== "")) continue;
    const packs = new Set(group.map((l) => l.pack).filter((p) => p > 0));
    if (packs.size > 1) continue; // units are not additive across packs: left to the per-pack fold
    if (
      !group.every(
        (l) =>
          isBuyerPricedLine({ priceType: l.priceType, overriddenBy: l.overriddenBy }) &&
          !(l.priceType === PriceType.PROMO && l.originalPrice != null),
      )
    )
      continue; // an operator price or a price promotion is never given free units on top
    // The ONE pack the product's lines share: a snapshot when any line has one, else the live pack (a legacy
    // box-split line with a null snapshot is still counted, and billed, in its real boxes).
    const upb = [...packs].find((p) => p > 1) ?? Number(opts.liveUnitsPerBoxFor?.(productId) ?? 0);
    const shaped = group.map((l) => ({ qty: l.qty, boxes: l.boxes, pieces: l.pieces }));
    const combined = productPromotionQty(shaped, upb);
    const caps = shaped.map((l) => linePromoUnits(l, upb));
    const total = rescaleBogoFreeUnits({
      promos: [...opts.promos],
      productId,
      category: opts.categoryFor(productId),
      unitPrice: group[0].unitPrice,
      storedFreeUnits: base ? base.free : group.reduce((n, l) => n + l.free, 0),
      oldUnits: base ? base.units : caps.reduce((n, c) => n + c, 0),
      newUnits: combined.qtyUnits,
      canEarnNew: opts.canEarnNew,
    });
    const shares = allocateFreeUnits(total, caps);
    group.forEach((l, i) => {
      if (shares[i] === l.free) return;
      out.push({
        key: l.key,
        free: shares[i],
        subtotal: computeLineSubtotal({
          unitPrice: l.unitPrice,
          qty: l.qty,
          boxes: l.boxes,
          pieces: l.pieces,
          unitsPerBox: l.boxes != null && upb > 1 ? upb : null,
          freeUnits: shares[i],
        }),
      });
    });
  }
  return out;
}
