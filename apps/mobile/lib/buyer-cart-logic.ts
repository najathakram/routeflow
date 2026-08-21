/**
 * BUY_N_GET_M ("buy N, get the next M free") display helpers — pure logic,
 * Jest-tested, no RN imports. Shared by the buyer cart (`buyer-cart-pricing.ts`)
 * and the catalogue tile (`catalog-tile-logic.ts`) so both derive the promo's
 * `qtyUnits` gate and the free-units label/chip the same way. Mirrors the web
 * buyer cart + shop tile (web is golden) — display parity only; all pricing
 * math (the floor formula, the exact subtotal) stays in `lib/pricing.ts`.
 */
import { promotionMatchesProduct, type PromoContext, type PromotionType } from "./pricing";
import type { BuyerPromotion } from "./api/buyer";

export interface SellingUnitsInput {
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}

/**
 * Whole SELLING units on a line — feeds `PromoContext.qtyUnits`: full boxes
 * for a boxed line (loose pieces below a box NEVER count toward BUY_N_GET_M —
 * a mixed 5-boxes-+-40-pieces line stays 0 free until the 6th whole box),
 * plain qty (pieces) for a non-boxed line. Mirrors how `qtyPieces` is sourced
 * today (`normalizeBoxesPieces`), just expressed in selling units instead.
 */
export function sellingUnits({ qty, boxes, pieces, unitsPerBox }: SellingUnitsInput): number {
  const upb = Number(unitsPerBox ?? 0);
  if (upb > 1) return Math.max(0, Math.trunc(Number(boxes ?? 0)));
  return Math.max(0, Math.trunc(Number(qty ?? 0)));
}

/** "2 free" line label — null when nothing is free (never render an empty chip). */
export function freeUnitsLabel(freeUnits: number | null | undefined): string | null {
  const n = Math.trunc(Number(freeUnits ?? 0));
  return n > 0 ? `${n} free` : null;
}

/** Generic chip fallback when a BUY_N_GET_M promo has no admin-authored `bannerText`. */
export const BOGO_FALLBACK_BANNER = "Buy N get M free";

/**
 * Chip text for a BUY_N_GET_M promo: its own `bannerText` when set, else the
 * generic fallback. Never a fake "-N%" — this promo type never changes the
 * unit price (see `PromoResult.freeUnits`).
 */
export function bogoBannerText(promo: Pick<BuyerPromotion, "bannerText">): string {
  const text = (promo.bannerText ?? "").trim();
  return text.length > 0 ? text : BOGO_FALLBACK_BANNER;
}

/**
 * A BUY_N_GET_M promo that scope-matches this product, independent of the
 * current quantity — so a shopper sees the deal chip before they've added
 * enough to actually earn a free unit (the tile/detail chip is qty-agnostic;
 * only the cart/order line's `freeUnits` count depends on qty). Ties broken
 * by id, same as `applyBestPromotion`, when more than one BOGO promo matches.
 *
 * `BuyerPromotion.type` is a narrower API-response union that predates this
 * promo type (`lib/api/buyer.ts`) — the cast to `PromotionType` just widens it
 * back to the shared pricing union so the literal comparison below type-checks;
 * it does not change what value `p.type` actually holds at runtime.
 */
export function matchingBogoPromo(
  promos: BuyerPromotion[] | undefined,
  ctx: { productId: string; category?: string | null },
): BuyerPromotion | null {
  const scopeCtx: PromoContext = { ...ctx, qtyPieces: 0, qtyUnits: 0 };
  let best: BuyerPromotion | null = null;
  for (const p of promos ?? []) {
    if ((p.type as PromotionType) !== "BUY_N_GET_M") continue;
    if (!promotionMatchesProduct(p, scopeCtx)) continue;
    if (best == null || p.id < best.id) best = p;
  }
  return best;
}
