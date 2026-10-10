/**
 * Buyer product detail (#2345, W>M) — pure logic, Jest-tested (no RN imports).
 * Mirrors web's `buyer/portal/[seller]/shop/[productId]/page.tsx`. Money goes
 * through `deriveTilePrice` (catalog-tile-logic) so a detail or variant price
 * equals the tile and the cart to the cent — never a raw `buyerPrice`.
 */
import type { PromotionRule, PromoResult } from "@routeflow/pricing";
import type { BuyerProductVariant } from "@routeflow/types";
import { deriveTilePrice } from "./catalog-tile-logic";
import type { BuyerProduct } from "./api/buyer";
import type { CartItem } from "../store/cartStore";

export type ProductDetailState = "loading" | "not-available" | "error" | "ready";

/**
 * The endpoint is tenant/link/license-gated: 404 = "doesn't exist or you can't
 * see it" (incl. a locked regulated category), 403 = the buyer/seller context
 * guard. Both render the SAME non-leaking "not available" card — never tell
 * them apart. Anything else (network / 5xx) is a retryable error.
 */
export function productDetailState(q: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  hasData: boolean;
}): ProductDetailState {
  if (q.isLoading) return "loading";
  if (q.isError) {
    const status = (q.error as { response?: { status?: number } } | null)?.response?.status;
    return status === 404 || status === 403 ? "not-available" : "error";
  }
  return q.hasData ? "ready" : "loading";
}

/** Gallery images: every imageUrl, else the thumbnail, else none (placeholder). */
export function galleryImages(p: {
  imageUrls?: string[] | null;
  thumbnailUrl?: string | null;
}): string[] {
  if (p.imageUrls && p.imageUrls.length > 0) return p.imageUrls;
  return p.thumbnailUrl ? [p.thumbnailUrl] : [];
}

/** "SKU: X · Barcode: Y" line, or null when the product has neither (web parity). */
export function identifierLine(p: { sku?: string | null; barcode?: string | null }): string | null {
  const parts = [p.sku ? `SKU: ${p.sku}` : null, p.barcode ? `Barcode: ${p.barcode}` : null];
  const present = parts.filter((x): x is string => x !== null);
  return present.length > 0 ? present.join(" · ") : null;
}

/**
 * A variant row's price — the same cent-exact path as the variant's own tile /
 * detail page (variants are catalog products in their own right). The server
 * sends `category: null`; the tile helper's input is `string | undefined`.
 */
export function variantPrice(
  v: BuyerProductVariant,
  promoRules: PromotionRule[],
  cartItem: CartItem | undefined,
): PromoResult {
  const input: Pick<BuyerProduct, "id" | "buyerPrice" | "category" | "unitsPerBox"> = {
    id: v.id,
    buyerPrice: v.buyerPrice,
    category: v.category,
    unitsPerBox: v.unitsPerBox,
  };
  return deriveTilePrice(input, promoRules, cartItem);
}
