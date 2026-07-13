"use client";

import * as React from "react";
import { Package, Heart, Plus } from "lucide-react";
import type { PromotionRule, PromoResult } from "@/lib/pricing";
import type { BuyerProduct, ReplenishmentEstimate } from "@/lib/api/buyer";
import type { CartItem } from "@/lib/buyer-cart";
import { objectPositionForUrl } from "@/lib/image-focal";
import { deriveTilePrice } from "./tile-pricing";
import { QtyStepper } from "./QtyStepper";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

/** Priority order: Deal (promo/merch) > New > Running low (behavioral) > Featured. Only one renders. */
function computeChip(
  product: BuyerProduct,
  priced: PromoResult,
  estimate?: ReplenishmentEstimate,
): { label: string; cls: string } | null {
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

function stockText(p: BuyerProduct): { label: string; cls: string } {
  const status = p.stockStatus ?? "IN_STOCK";
  if (status === "OUT_OF_STOCK") return { label: "Out of stock", cls: "text-danger" };
  if (status === "LOW")
    return {
      label: p.stockLeft != null ? `Only ${p.stockLeft} left` : "Low stock",
      cls: "text-warning",
    };
  return { label: "In stock", cls: "text-success" };
}

// ─── Product Tile (Catalogue v2) ───────────────────────────────────────────────

export interface ProductTileProps {
  product: BuyerProduct;
  /** undefined when the product is not in the cart. */
  cartItem: CartItem | undefined;
  promoRules: PromotionRule[];
  /** Behavioral chip source (replenishment frequency). */
  estimate?: ReplenishmentEstimate;
  isFavorite: boolean;
  onAdd: () => void;
  onUpdateQty: (qty: number) => void;
  onToggleFavorite: () => void;
}

export function ProductTile({
  product,
  cartItem,
  promoRules,
  estimate,
  isFavorite,
  onAdd,
  onUpdateQty,
  onToggleFavorite,
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
  const chip = computeChip(product, priced, estimate);
  const behavior = behaviorLabel(estimate);
  const stock = stockText(product);
  const outOfStock = (product.stockStatus ?? "IN_STOCK") === "OUT_OF_STOCK";

  return (
    <div
      className={`group flex flex-col rounded-xl border border-surface-border bg-white overflow-hidden hover:shadow-md transition-shadow ${outOfStock ? "opacity-90" : ""}`}
    >
      {/* Image block */}
      <div className="relative aspect-[4/5] overflow-hidden bg-surface-raised border-b border-surface-border">
        {currentUrl ? (
          <img
            src={currentUrl}
            alt={product.name}
            className={`h-full w-full object-cover ${images.length > 1 ? "cursor-pointer" : ""}`}
            style={{ objectPosition: objectPositionForUrl(currentUrl) }}
            onClick={() => {
              if (images.length > 1) setImgIdx((i) => (i + 1) % images.length);
            }}
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
            e.stopPropagation();
            onToggleFavorite();
          }}
          className={`absolute top-2 right-2 flex h-8 w-8 items-center justify-center rounded-full shadow-sm transition-colors ${
            isFavorite
              ? "bg-danger/10 text-danger hover:bg-danger hover:text-white"
              : "bg-white/90 text-navy/30 hover:text-danger"
          }`}
          title={isFavorite ? "Remove from favorites" : "Add to favorites"}
        >
          <Heart className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`} />
        </button>

        {images.length > 1 && (
          <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1">
            {images.map((_, i) => (
              <button
                key={i}
                onClick={(e) => {
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
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-navy line-clamp-2">{product.name}</h3>
          <p className="mt-0.5 text-[11px] text-navy/70">
            {behavior && <>{behavior} · </>}
            <span className={stock.cls}>{stock.label}</span>
          </p>
        </div>

        <div className="flex items-end justify-between gap-2">
          <div>
            <div className="flex items-baseline gap-1.5">
              <p className="text-lg font-bold text-navy">{fmt(priced.unitPrice)}</p>
              {priced.originalPrice != null && (
                <p className="text-[11px] text-navy/40 line-through">{fmt(priced.originalPrice)}</p>
              )}
            </div>
            <p className="text-[11px] text-navy/70">
              per {product.unit}
              {product.unitsPerBox ? ` (${product.unitsPerBox}/box)` : ""}
            </p>
          </div>

          {cartItem ? (
            <QtyStepper qty={cartItem.qty} onUpdate={onUpdateQty} onRemove={() => onUpdateQty(0)} />
          ) : (
            <button
              onClick={onAdd}
              disabled={outOfStock}
              className={`flex items-center gap-1.5 rounded-lg bg-buyer-500 px-3 py-2 text-xs font-semibold text-white hover:bg-buyer-600 transition-colors ${
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
