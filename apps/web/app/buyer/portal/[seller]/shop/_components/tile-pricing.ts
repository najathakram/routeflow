import {
  applyBestPromotion,
  normalizeBoxesPieces,
  type PromotionRule,
  type PromoResult,
} from "@/lib/pricing";
import type { BuyerProduct } from "@/lib/api/buyer";
import type { CartItem } from "@/lib/buyer-cart";

/**
 * Tile promo/struck price. MUST equal the cart's number for the same
 * product+qty TO THE CENT — this mirrors cart/page.tsx `pricedLines` exactly:
 *   base      = catalog `buyerPrice` (tier/effective price, server-resolved)
 *   qtyPieces = normalizeBoxesPieces(cart line when in cart, else the default
 *               add qty: 1 box for boxed products, 1 piece otherwise)
 *   result    = applyBestPromotion(base, rules, { productId, category, qtyPieces })
 * `rules` must come from `toPromotionRules(useBuyerPromotions().data)`.
 * result.unitPrice = net selling-unit price; result.originalPrice = struck
 * pre-promo price (null => no strikethrough).
 */
export function deriveTilePrice(
  product: Pick<BuyerProduct, "id" | "buyerPrice" | "category" | "unitsPerBox">,
  promoRules: PromotionRule[],
  cartItem: CartItem | undefined,
): PromoResult {
  const unitsPerBox = cartItem?.unitsPerBox ?? product.unitsPerBox ?? null;
  const qtyPieces = normalizeBoxesPieces({
    boxes: cartItem?.boxes ?? null,
    pieces: cartItem?.pieces ?? null,
    qty: cartItem?.qty ?? (product.unitsPerBox ? product.unitsPerBox : 1),
    unitsPerBox,
  }).qty;
  return applyBestPromotion(product.buyerPrice, promoRules, {
    productId: product.id,
    category: product.category ?? null,
    qtyPieces,
  });
}
