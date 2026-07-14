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
import type { BuyerProduct, BuyerStockAlerts, ReplenishmentEstimate } from "./api/buyer";
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
  return applyBestPromotion(base, promoRules, {
    productId: product.id,
    category: product.category ?? null,
    qtyPieces,
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
