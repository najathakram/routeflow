"use client";

import * as React from "react";
import { RetryableImg } from "@/components/RetryableImg";
import Link from "next/link";
import { Package, Heart, Plus, Bell } from "lucide-react";
import type { PromotionRule, PromoResult } from "@routeflow/pricing";
import type { BuyerProduct, BuyerPromotion, ReplenishmentEstimate } from "@/lib/api/buyer";
import type { CartItem } from "@/lib/buyer-cart";
import { objectPositionForUrl } from "@/lib/image-focal";
import { isOrderBlocked, stockLine } from "@/lib/buyer-backorder";
import { bogoChipLabel, deriveTilePrice } from "./tile-pricing";
import { QtyStepper } from "./QtyStepper";
import type { ShopDensity } from "../page";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

/** Priority order: Deal (promo/merch) > New > Running low (behavioral) > Featured. Only one renders. */
function computeChip(
  product: BuyerProduct,
  priced: PromoResult,
  bogoLabel: string | null,
  estimate?: ReplenishmentEstimate,
): { label: string; cls: string } | null {
  // BUY_N_GET_M first: it leaves `originalPrice` null (no fake unit price), so
  // its chip is the promo's banner text — never a derived "-N%".
  if (bogoLabel) return { label: bogoLabel, cls: "bg-success text-white" };
  if (priced.originalPrice != null || product.isDeal) {
    let label = "Deal";
    // Display-only percent derived from the already-rounded priced result — never fed back into money math.
    if (priced.originalPrice != null && priced.originalPrice > 0) {
      const percent = Math.round((1 - priced.unitPrice / priced.originalPrice) * 100);
      if (percent > 0) label = `Deal -${percent}%`;
    }
    return { label, cls: "bg-success text-white" };
  }
  if (product.isNew) return { label: "New", cls: "bg-info text-white" };
  if (estimate?.state === "low") return { label: "Running low", cls: "bg-warning text-white" };
  if (product.isFeatured) return { label: "Featured", cls: "bg-warning text-white" };
  return null;
}

function behaviorLabel(est?: ReplenishmentEstimate): string | null {
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

// ─── Product Tile (Catalogue v2) ───────────────────────────────────────────────

export interface ProductTileProps {
  product: BuyerProduct;
  /** Seller slug — builds the detail link `/buyer/portal/{sellerSlug}/shop/{product.id}`. */
  sellerSlug: string;
  /** undefined when the product is not in the cart. */
  cartItem: CartItem | undefined;
  promoRules: PromotionRule[];
  /** Raw promo list — only for the BUY_N_GET_M chip's `bannerText` (not pricing). */
  promotions?: BuyerPromotion[];
  /** Behavioral chip source (replenishment frequency). */
  estimate?: ReplenishmentEstimate;
  isFavorite: boolean;
  onAdd: () => void;
  onUpdateQty: (qty: number) => void;
  onToggleFavorite: () => void;
  /** P5-03: Notify-me subscribed state + toggle. Only rendered when the tile is OOS and not in the cart. */
  isAlertSubscribed?: boolean;
  onToggleStockAlert?: () => void;
  /** Grid density from the shop toolbar. Only "sm" trims paddings/type — "md"/"lg" render identically. */
  size?: ShopDensity;
}

export function ProductTile({
  product,
  sellerSlug,
  cartItem,
  promoRules,
  promotions,
  estimate,
  isFavorite,
  onAdd,
  onUpdateQty,
  onToggleFavorite,
  isAlertSubscribed,
  onToggleStockAlert,
  size = "lg",
}: ProductTileProps) {
  const images = product.imageUrls?.length
    ? product.imageUrls
    : product.thumbnailUrl
      ? [product.thumbnailUrl]
      : [];
  const [imgIdx, setImgIdx] = React.useState(0);
  const currentUrl = images.length > 0 ? images[Math.min(imgIdx, images.length - 1)] : null;

  // Cent-parity anchor — MUST equal the cart's number for this product+qty.
  const priced = deriveTilePrice(product, promoRules, cartItem);
  const chip = computeChip(product, priced, bogoChipLabel(product, promotions), estimate);
  const behavior = behaviorLabel(estimate);
  // OOS PR2: an out-of-stock item this buyer may order anyway ("Ships when restocked") is NOT blocked.
  const stock = stockLine(product);
  const outOfStock = isOrderBlocked(product);
  const isCompact = size === "sm";
  const detailHref = `/buyer/portal/${sellerSlug}/shop/${product.id}`;

  return (
    <div
      className={`group flex flex-col rounded-xl border border-surface-border bg-white overflow-hidden hover:shadow-md transition-shadow ${outOfStock ? "opacity-90" : ""}`}
      data-testid="product-tile"
    >
      {/* Image block — clicking it (or the name below) opens the detail page. */}
      <Link
        href={detailHref}
        data-testid="product-tile-link"
        className="relative block aspect-[4/5] overflow-hidden bg-surface-raised border-b border-surface-border"
      >
        {currentUrl ? (
          <RetryableImg
            staleQueryKey={["buyer", "products"]}
            src={currentUrl}
            alt={product.name}
            className="h-full w-full object-cover"
            style={{ objectPosition: objectPositionForUrl(currentUrl) }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Package className="h-12 w-12 text-navy/15" />
          </div>
        )}

        {chip && (
          <span
            className={`absolute top-2 left-2 rounded-full px-2 py-0.5 text-[10px] font-semibold shadow-sm ${chip.cls}`}
          >
            {chip.label}
          </span>
        )}

        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleFavorite();
          }}
          // 44px hit area; the visible circle (inner span) keeps its old size.
          className="group/fav absolute top-0.5 right-0.5 flex min-h-11 min-w-11 items-center justify-center"
          title={isFavorite ? "Remove from favorites" : "Add to favorites"}
        >
          <span
            className={`flex items-center justify-center rounded-full shadow-sm transition-colors ${isCompact ? "h-7 w-7" : "h-8 w-8"} ${
              isFavorite
                ? "bg-danger/10 text-danger group-hover/fav:bg-danger group-hover/fav:text-white"
                : "bg-white/90 text-navy/30 group-hover/fav:text-danger"
            }`}
          >
            <Heart className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`} />
          </span>
        </button>

        {images.length > 1 && (
          <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1">
            {images.map((_, i) => (
              <button
                key={i}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setImgIdx(i);
                }}
                className={`h-1.5 w-1.5 rounded-full transition-colors ${
                  i === imgIdx ? "bg-buyer-500" : "bg-white/70 border border-surface-border"
                }`}
                aria-label={`Show image ${i + 1}`}
              />
            ))}
          </div>
        )}
      </Link>

      {/* Body */}
      <div className={`flex flex-1 flex-col gap-2 ${isCompact ? "p-2" : "p-3"}`}>
        <div className="flex-1">
          <Link href={detailHref} className="block">
            <h3
              className={`font-semibold text-navy line-clamp-2 ${isCompact ? "text-xs" : "text-sm"}`}
            >
              {product.name}
            </h3>
          </Link>
          <p className={`mt-0.5 text-navy/70 ${isCompact ? "text-[10px]" : "text-[11px]"}`}>
            {!isCompact && behavior && <>{behavior} · </>}
            <span className={stock.cls}>{stock.label}</span>
          </p>
        </div>

        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5">
              <p className={`font-bold text-navy ${isCompact ? "text-base" : "text-lg"}`}>
                {fmt(priced.unitPrice)}
              </p>
              {priced.originalPrice != null && (
                <p className="text-[11px] text-navy/40 line-through">{fmt(priced.originalPrice)}</p>
              )}
            </div>
            <p className={`text-navy/70 ${isCompact ? "text-[10px]" : "text-[11px]"}`}>
              per {product.unit}
              {product.unitsPerBox ? ` (${product.unitsPerBox}/box)` : ""}
            </p>
          </div>

          {cartItem ? (
            <QtyStepper qty={cartItem.qty} onUpdate={onUpdateQty} onRemove={() => onUpdateQty(0)} />
          ) : outOfStock && onToggleStockAlert ? (
            <button
              onClick={onToggleStockAlert}
              className={`flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                isAlertSubscribed
                  ? "border border-buyer-500 text-buyer-600 hover:bg-buyer-50"
                  : "bg-buyer-500 text-white hover:bg-buyer-600"
              }`}
            >
              <Bell className={`h-3.5 w-3.5 ${isAlertSubscribed ? "fill-current" : ""}`} />
              {isAlertSubscribed ? "Notifying ✓" : "Notify me"}
            </button>
          ) : (
            <button
              onClick={onAdd}
              disabled={outOfStock}
              className={`flex min-h-11 items-center gap-1.5 rounded-lg bg-buyer-500 text-xs font-semibold text-white hover:bg-buyer-600 transition-colors ${isCompact ? "px-2 py-1.5" : "px-3 py-2"} ${
                outOfStock ? "opacity-60 cursor-not-allowed" : ""
              }`}
            >
              <Plus className="h-3.5 w-3.5" /> Add
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ProductTile;
