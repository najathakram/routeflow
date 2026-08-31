/**
 * Catalogue-v2 tile logic (P5-16a) — pure, Jest-tested (no RN imports).
 * Mirrors the web shop tile helpers (tile-pricing.ts + ProductTile.tsx).
 * Money goes through lib/pricing so the tile price matches the cart — and the
 * server bill — to the cent. NEVER recompute prices ad-hoc.
 */
import {
  applyBestPromotion,
  normalizeBoxesPieces,
  type PromotionRule,
  type PromoResult,
} from "./pricing";
import { bogoBannerText, matchingBogoPromo, sellingUnits } from "./buyer-cart-logic";
import type {
  BuyerProduct,
  BuyerPromotion,
  BuyerStockAlerts,
  ReplenishmentEstimate,
} from "./api/buyer";
import type { CartItem } from "../store/cartStore";

export type TileCta = "stepper" | "notify" | "add";

/** In-cart → stepper (even if now OOS); OOS → notify; else → add. */
export function tileCta(product: Pick<BuyerProduct, "stockStatus">, inCartUnits: number): TileCta {
  if (inCartUnits > 0) return "stepper";
  if ((product.stockStatus ?? "IN_STOCK") === "OUT_OF_STOCK") return "notify";
  return "add";
}

export function alertIdSet(alerts: BuyerStockAlerts | undefined): Set<string> {
  return new Set(alerts?.productIds ?? []);
}

/**
 * Tile promo/struck price — MUST equal the cart number for the same product+qty
 * to the cent (same inputs as buyer-cart-pricing.priceCart).
 */
export function deriveTilePrice(
  product: Pick<
    BuyerProduct,
    "id" | "buyerPrice" | "basePrice" | "price" | "category" | "unitsPerBox"
  >,
  promoRules: PromotionRule[],
  cartItem: CartItem | undefined,
): PromoResult {
  const base = Number(product.buyerPrice ?? product.basePrice ?? product.price) || 0;
  const upb = Number(product.unitsPerBox ?? 0);
  const unitsPerBox = cartItem?.unitsPerBox ?? product.unitsPerBox ?? null;
  const qtyPieces = normalizeBoxesPieces({
    boxes: cartItem?.boxes ?? null,
    pieces: cartItem?.pieces ?? null,
    qty: cartItem?.qty ?? (upb > 1 ? upb : 1),
    unitsPerBox,
  }).qty;
  // The would-be-added quantity outside a cart is 1 whole selling unit (1 box
  // or 1 piece) — mirrors how qtyPieces is sourced above.
  const qtyUnits = cartItem
    ? sellingUnits({
        qty: cartItem.qty,
        boxes: cartItem.boxes ?? null,
        pieces: cartItem.pieces ?? null,
        unitsPerBox,
      })
    : 1;
  return applyBestPromotion(base, promoRules, {
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

export type TileChipKind = "deal" | "new" | "low" | "featured";
export interface TileChip {
  kind: TileChipKind;
  label: string;
}

/** Priority: Deal > New > Running low > Featured. Only one renders. */
export function computeTileChip(
  product: Pick<BuyerProduct, "isDeal" | "isNew" | "isFeatured">,
  priced: PromoResult,
  estimate?: ReplenishmentEstimate,
): TileChip | null {
  if (priced.originalPrice != null || product.isDeal) {
    let label = "Deal";
    if (priced.originalPrice != null && priced.originalPrice > 0) {
      const percent = Math.round((1 - priced.unitPrice / priced.originalPrice) * 100);
      if (percent > 0) label = `Deal -${percent}%`;
    }
    return { kind: "deal", label };
  }
  if (product.isNew) return { kind: "new", label: "New" };
  if (estimate?.state === "low") return { kind: "low", label: "Running low" };
  if (product.isFeatured) return { kind: "featured", label: "Featured" };
  return null;
}

/**
 * BUY_N_GET_M deal chip: shown whenever a matching promo exists for this
 * product, regardless of the tile's current (pre-cart) quantity — so a
 * shopper sees "Buy 5 get 1 free" before adding enough to actually earn a
 * free unit. Takes priority over `computeTileChip` (call this FIRST); never a
 * fake percent — this promo type never changes the unit price. Additive: does
 * not alter `computeTileChip`'s existing Deal/New/Low/Featured behavior.
 */
export function bogoTileChip(
  product: Pick<BuyerProduct, "id" | "category">,
  promotions: BuyerPromotion[] | undefined,
): TileChip | null {
  const promo = matchingBogoPromo(promotions, {
    productId: product.id,
    category: product.category ?? null,
  });
  if (!promo) return null;
  return { kind: "deal", label: bogoBannerText(promo) };
}

export function behaviorLabel(est?: ReplenishmentEstimate): string | null {
  if (!est || est.orderCount < 2) return null;
  const c = est.cadenceDays;
  if (c != null) {
    if (c >= 5 && c <= 9) return "You order weekly";
    if (c >= 12 && c <= 18) return "You order biweekly";
    if (c >= 25 && c <= 35) return "You order monthly";
    return `You order every ~${c} days`;
  }
  return `Bought ${est.orderCount}x`;
}

export type StockTone = "ok" | "warn" | "danger";
export interface StockLabelResult {
  label: string;
  tone: StockTone;
}

export function stockLabel(p: Pick<BuyerProduct, "stockStatus" | "stockLeft">): StockLabelResult {
  const status = p.stockStatus ?? "IN_STOCK";
  if (status === "OUT_OF_STOCK") return { label: "Out of stock", tone: "danger" };
  if (status === "LOW")
    return { label: p.stockLeft != null ? `Only ${p.stockLeft} left` : "Low stock", tone: "warn" };
  return { label: "In stock", tone: "ok" };
}
