"use client";

import * as React from "react";
import { Plus, RotateCcw } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import type {
  OrderSuggestionProduct,
  OrderSuggestionsResponse,
  RecentOrderSummary,
} from "@routeflow/types";
import { formatDate } from "@/lib/format";
import { displayProductName } from "@/lib/product-display";
import { ORDER_AGAIN_COPY, orderAgainSummary } from "./order-again";

interface Props {
  suggestions: OrderSuggestionsResponse | undefined;
  /** The order already has lines: "Order again" asks before adding. */
  hasLines: boolean;
  /** A chip tap: one more of the product, through the order's normal add-line path. */
  onAddProduct: (product: OrderSuggestionProduct) => void;
  /** An "Order again" pick: that order's lines, re-priced today. */
  onOrderAgain: (order: RecentOrderSummary) => void;
  /** The suggestions could not be loaded: say so quietly (order entry is unaffected). */
  error?: boolean;
  /** The "Order again" menu is open. Owned by the order modal so its Escape closes only the menu. */
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}

/**
 * Under the customer picker in staff New Order: the products this customer usually buys (tap to
 * add) and a menu of their last orders (pick one to add its lines again). It carries no price, and
 * quietly renders nothing while loading, on failure, or for a customer with no history.
 */
export function OrderSuggestionsBar({
  suggestions,
  hasLines,
  onAddProduct,
  onOrderAgain,
  error,
  menuOpen,
  onMenuOpenChange,
}: Props) {
  const setMenuOpen = onMenuOpenChange;
  const [confirming, setConfirming] = React.useState<RecentOrderSummary | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  // Closing the menu (Escape, a pick, the toggle) hands focus back to the button that opened it.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (wasOpen.current && !menuOpen) triggerRef.current?.focus();
    wasOpen.current = menuOpen;
  }, [menuOpen]);

  const products = suggestions?.products ?? {};
  const chips = (Array.isArray(suggestions?.usuallyBuys) ? suggestions!.usuallyBuys : [])
    .map((u) => products[u.productId])
    .filter((p): p is OrderSuggestionProduct => !!p && p.isActive);
  const orders = Array.isArray(suggestions?.recentOrders) ? suggestions!.recentOrders : [];
  if (chips.length === 0 && orders.length === 0) {
    return error ? (
      <p className="text-xs text-navy/60" data-testid="order-suggestions-unavailable">
        {ORDER_AGAIN_COPY.unavailable}
      </p>
    ) : null;
  }

  const pickOrder = (order: RecentOrderSummary) => {
    if (hasLines) {
      setConfirming(order);
      return;
    }
    setMenuOpen(false);
    onOrderAgain(order);
  };

  return (
    <div className="space-y-2" data-testid="order-suggestions">
      {chips.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-navy/70">{ORDER_AGAIN_COPY.usuallyBuys}</p>
          <div className="flex flex-wrap gap-1.5">
            {chips.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onAddProduct(p)}
                className="inline-flex min-h-[44px] max-w-full items-center gap-1 rounded-full border border-surface-border bg-white px-3 text-sm text-navy transition-colors hover:bg-surface-raised sm:min-h-[36px]"
              >
                <Plus className="h-3.5 w-3.5 shrink-0 text-navy/70" aria-hidden />
                <span className="truncate">{displayProductName(p)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {orders.length > 0 && (
        <div className="space-y-1.5">
          <button
            ref={triggerRef}
            type="button"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen(!menuOpen);
              setConfirming(null);
            }}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded border border-surface-border bg-white px-3 text-sm font-medium text-navy transition-colors hover:bg-surface-raised sm:min-h-[36px]"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            {ORDER_AGAIN_COPY.orderAgain}
          </button>

          {menuOpen && (
            <ul
              aria-label={ORDER_AGAIN_COPY.chooseOrder}
              className="overflow-hidden rounded-lg border border-surface-border bg-white"
            >
              {orders.map((o) => (
                <li key={o.id} className="border-b border-surface-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => pickOrder(o)}
                    className={cn(
                      "block w-full px-3 py-2 text-left hover:bg-surface-raised",
                      confirming?.id === o.id && "bg-brand-50",
                    )}
                  >
                    <span className="block text-sm font-medium text-navy">
                      {o.orderNumber ?? "Order"} · {formatDate(o.date)}
                    </span>
                    <span className="block truncate text-xs text-navy/70">
                      {orderAgainSummary(o, products)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {confirming && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-300 bg-brand-50 px-3 py-2 text-sm text-navy"
            >
              <span className="min-w-0 flex-1">{ORDER_AGAIN_COPY.confirmLines}</span>
              <button
                type="button"
                onClick={() => {
                  const order = confirming;
                  setConfirming(null);
                  setMenuOpen(false);
                  onOrderAgain(order);
                }}
                className="min-h-[44px] rounded bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700 sm:min-h-[36px]"
              >
                {ORDER_AGAIN_COPY.confirmAdd}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="min-h-[44px] rounded border border-surface-border bg-white px-3 text-sm text-navy hover:bg-surface-raised sm:min-h-[36px]"
              >
                {ORDER_AGAIN_COPY.confirmCancel}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
