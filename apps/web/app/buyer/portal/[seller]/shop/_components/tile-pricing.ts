import {
  applyBestPromotion,
  normalizeBoxesPieces,
  promotionMatchesProduct,
  type PromotionRule,
  type PromoResult,
} from "@/lib/pricing";
import type { BuyerProduct, BuyerPromotion } from "@/lib/api/buyer";
import type { CartItem } from "@/lib/buyer-cart";

/**
 * Tile promo/struck price. MUST equal the cart's number for the same
 * product+qty TO THE CENT — this mirrors cart/page.tsx `pricedLines` exactly:
 *   base      = catalog `buyerPrice` (tier/effective price, server-resolved)
 *   qtyPieces = normalizeBoxesPieces(cart line when in cart, else the default
 *               add qty: 1 box for boxed products, 1 piece otherwise)
 *   qtyUnits  = whole selling units on that same line — boxes for a boxed
 *               product (loose pieces below a full box never count), the
 *               qty itself for a piece line; 1 unit when nothing is in the
 *               cart yet (the would-be-added quantity), the cart item's
 *               units when present. Sourced the same way as qtyPieces above,
 *               and required by the BUY_N_GET_M gate in applyBestPromotion.
 *   split     = the cart line's own boxes/pieces/unitsPerBox (null when the
 *               product isn't in the cart yet) — REG-B109: promo selection
 *               compares candidates by the money the CART bills, so a mixed
 *               box+piece line's loose pieces are not dropped from the compare.
 *   result    = applyBestPromotion(base, rules, { productId, category, qtyPieces,
 *               qtyUnits, ...split })
 * `rules` must come from `toPromotionRules(useBuyerPromotions().data)`.
 * result.unitPrice = net selling-unit price; result.originalPrice = struck
 * pre-promo price (null => no strikethrough, always null for BUY_N_GET_M —
 * that type never fakes a unit price); result.freeUnits = whole units given
 * free by a BUY_N_GET_M promo (0 otherwise).
 */
export function deriveTilePrice(
  product: Pick<BuyerProduct, "id" | "buyerPrice" | "category" | "unitsPerBox">,
  promoRules: PromotionRule[],
  cartItem: CartItem | undefined,
): PromoResult {
  const unitsPerBox = cartItem?.unitsPerBox ?? product.unitsPerBox ?? null;
  const norm = normalizeBoxesPieces({
    boxes: cartItem?.boxes ?? null,
    pieces: cartItem?.pieces ?? null,
    qty: cartItem?.qty ?? (product.unitsPerBox ? product.unitsPerBox : 1),
    unitsPerBox,
  });
  const qtyPieces = norm.qty;
  const qtyUnits = norm.boxes != null ? norm.boxes : norm.qty;
  return applyBestPromotion(product.buyerPrice, promoRules, {
    productId: product.id,
    category: product.category ?? null,
    qtyPieces,
    qtyUnits,
    // REG-B109: the cart line's own denomination, so selection compares by the
    // money the CART bills (loose pieces included) and the tile keeps matching
    // it to the cent. No cart line yet => null, i.e. the 1-unit add above.
    boxes: cartItem?.boxes ?? null,
    pieces: cartItem?.pieces ?? null,
    unitsPerBox,
  });
}

/** Generic chip text when a BUY_N_GET_M promo has no admin-authored `bannerText`. */
export const BOGO_FALLBACK_BANNER = "Buy N get M free";

/**
 * Deal-chip text for a BUY_N_GET_M promo that scope-matches this product, or
 * null when none does. Qty-agnostic on purpose — a shopper sees "Buy 5 get 1
 * free" before adding enough to actually earn a free unit (only the cart line's
 * `freeUnits` count depends on quantity). The label is the promo's own
 * `bannerText`, else `BOGO_FALLBACK_BANNER`; NEVER a "-N%" — this promo type
 * never changes the unit price. Ties broken by id, same as `applyBestPromotion`.
 * The tile + detail chips both call this so they read identically.
 */
export function bogoChipLabel(
  product: Pick<BuyerProduct, "id" | "category">,
  promotions: BuyerPromotion[] | undefined,
): string | null {
  const ctx = {
    productId: product.id,
    category: product.category ?? null,
    qtyPieces: 0,
    qtyUnits: 0,
  };
  let best: BuyerPromotion | null = null;
  for (const p of promotions ?? []) {
    if (p.type !== "BUY_N_GET_M") continue;
    if (!promotionMatchesProduct(p, ctx)) continue;
    if (best == null || p.id < best.id) best = p;
  }
  if (!best) return null;
  const text = (best.bannerText ?? "").trim();
  return text.length > 0 ? text : BOGO_FALLBACK_BANNER;
}
