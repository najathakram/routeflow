"use client";

import { Plus, Bell } from "lucide-react";
import type { PromotionRule, PromoResult } from "@/lib/pricing";
import type { BuyerProductDetail } from "@/lib/api/buyer";
import type { CartItem } from "@/lib/buyer-cart";
import { deriveTilePrice } from "../../_components/tile-pricing";
import { QtyStepper } from "../../_components/QtyStepper";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

/**
 * Simplified badge for the detail page: Deal (promo/merch) takes priority,
 * then New, then Featured. Mirrors ProductTile's computeChip minus the
 * behavioral "Running low" case — the detail page has no replenishment
 * estimate to key that off of.
 */
function computeChip(
  product: Pick<BuyerProductDetail, "isDeal" | "isNew" | "isFeatured">,
  priced: PromoResult,
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
  if (product.isFeatured) return { label: "Featured", cls: "bg-warning text-white" };
  return null;
}

// ─── Detail Actions (price block + Add / Stepper / Notify-me) ─────────────────

export interface DetailActionsProps {
  product: BuyerProductDetail;
  /** undefined when the product is not in the cart. */
  cartItem: CartItem | undefined;
  promoRules: PromotionRule[];
  onAdd: () => void;
  onUpdateQty: (qty: number) => void;
  isAlertSubscribed: boolean;
  onToggleStockAlert: () => void;
}

export function DetailActions({
  product,
  cartItem,
  promoRules,
  onAdd,
  onUpdateQty,
  isAlertSubscribed,
  onToggleStockAlert,
}: DetailActionsProps) {
  // Cent-parity anchor — MUST equal the tile's and cart's number for this product+qty.
  const priced = deriveTilePrice(product, promoRules, cartItem);
  const chip = computeChip(product, priced);
  const outOfStock = (product.stockStatus ?? "IN_STOCK") === "OUT_OF_STOCK";

  return (
    <div className="flex flex-col gap-4">
      {chip && (
        <span
          className={`inline-flex w-fit items-center rounded-full px-2.5 py-1 text-xs font-semibold ${chip.cls}`}
        >
          {chip.label}
        </span>
      )}

      <div data-testid="product-detail-price">
        <div className="flex items-baseline gap-2">
          <p className="text-3xl font-bold text-navy">{fmt(priced.unitPrice)}</p>
          {priced.originalPrice != null && (
            <p className="text-base text-navy/40 line-through">{fmt(priced.originalPrice)}</p>
          )}
        </div>
        <p className="mt-1 text-sm text-navy/70">
          per {product.unit}
          {product.unitsPerBox ? ` (${product.unitsPerBox}/box)` : ""}
        </p>
      </div>

      <div>
        {cartItem ? (
          <QtyStepper qty={cartItem.qty} onUpdate={onUpdateQty} onRemove={() => onUpdateQty(0)} />
        ) : outOfStock ? (
          <button
            onClick={onToggleStockAlert}
            className={`flex items-center gap-2 rounded-lg px-5 py-3 text-sm font-semibold transition-colors ${
              isAlertSubscribed
                ? "border border-buyer-500 text-buyer-600 hover:bg-buyer-50"
                : "bg-buyer-500 text-white hover:bg-buyer-600"
            }`}
          >
            <Bell className={`h-4 w-4 ${isAlertSubscribed ? "fill-current" : ""}`} />
            {isAlertSubscribed ? "Notifying ✓" : "Notify me"}
          </button>
        ) : (
          <button
            data-testid="product-detail-add"
            onClick={onAdd}
            className="flex items-center gap-2 rounded-lg bg-buyer-500 px-5 py-3 text-sm font-semibold text-white hover:bg-buyer-600 transition-colors"
          >
            <Plus className="h-4 w-4" /> Add to cart
          </button>
        )}
      </div>
    </div>
  );
}

export default DetailActions;
