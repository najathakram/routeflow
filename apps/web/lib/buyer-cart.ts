"use client";

import * as React from "react";
import {
  completeLineFromCatalog,
  hydrateCartLine,
  lineCount,
  mergeCartLines,
  normalizeCartLine,
  setLineCount,
  setLineUnit,
  type CartUnit,
} from "./buyer-cart-line";

/**
 * A buyer cart line. For a boxed product (`unitsPerBox > 1`) `qty` is PIECES and
 * `qty === boxes * unitsPerBox + pieces` after every mutation (see `buyer-cart-line.ts`, the one
 * place that is computed); `sellBy` is the unit the stepper counts in (default CASE).
 */
export interface CartItem {
  productId: string;
  qty: number;
  name: string;
  unit: string;
  thumbnailUrl?: string | null;
  unitsPerBox?: number | null;
  boxes?: number | null;
  pieces?: number | null;
  sellBy?: CartUnit;
  /** Set when hydration or a repack rebuilt this line; the cart banner counts it. Never sent. */
  corrected?: boolean;
}

interface CartState {
  items: CartItem[];
}

function getCartKey(buyerAccountId: string, sellerSlug: string) {
  return `buyerCart_${buyerAccountId}_${sellerSlug}`;
}

/** True when two flat stored lines differ in any field (key order never matters). */
const lineDiffers = (a: CartItem, b: CartItem) =>
  Object.keys({ ...a, ...b }).some(
    (k) =>
      (a as unknown as Record<string, unknown>)[k] !== (b as unknown as Record<string, unknown>)[k],
  );

function readCart(key: string): CartState {
  if (typeof window === "undefined") return { items: [] };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { items: [] };
    const parsed = JSON.parse(raw) as CartState;
    const stored = Array.isArray(parsed.items) ? parsed.items : [];
    // Hydration: a stored line whose qty and box split disagree (the row-531 shape) is rebuilt
    // from `qty`, so the row, the subtotal and the checkout payload can never disagree, and it is
    // flagged `corrected` so the cart can say so once.
    const items = stored.map((i) => hydrateCartLine(i));
    // Write the repair back, flag included: otherwise the stale split sits in storage until the
    // next write, and a second read would no longer know the line was ever corrected.
    if (items.some((it, n) => lineDiffers(it, stored[n]))) {
      try {
        localStorage.setItem(key, JSON.stringify({ items }));
      } catch {
        // storage full or blocked: the in-memory repair still holds
      }
    }
    return { items };
  } catch {
    return { items: [] };
  }
}

function writeCart(key: string, state: CartState) {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, JSON.stringify(state));
  // Dispatch custom event so OTHER hook instances in the same tab update immediately.
  // (The native 'storage' event only fires in other tabs/windows.)
  window.dispatchEvent(new CustomEvent("cart-updated", { detail: { key } }));
}

/**
 * Hook for managing a client-side shopping cart stored in localStorage.
 * Cart is keyed per buyer + seller to prevent cross-contamination.
 * Prices are NOT stored — they're resolved fresh from the catalog API.
 */
export function useBuyerCart(buyerAccountId?: string, sellerSlug?: string) {
  const key = buyerAccountId && sellerSlug ? getCartKey(buyerAccountId, sellerSlug) : null;
  const [cart, setCart] = React.useState<CartState>({ items: [] });

  // Load from localStorage on mount
  React.useEffect(() => {
    if (!key) return;
    setCart(readCart(key));
  }, [key]);

  // Cross-tab sync + same-tab sync via custom event
  React.useEffect(() => {
    if (!key) return;
    const storageHandler = (e: StorageEvent) => {
      if (e.key === key) setCart(readCart(key));
    };
    const cartHandler = (e: Event) => {
      if ((e as CustomEvent).detail?.key === key) setCart(readCart(key));
    };
    window.addEventListener("storage", storageHandler);
    window.addEventListener("cart-updated", cartHandler);
    return () => {
      window.removeEventListener("storage", storageHandler);
      window.removeEventListener("cart-updated", cartHandler);
    };
  }, [key]);

  const addItem = React.useCallback(
    (item: CartItem) => {
      setCart((prev) => {
        const incoming = normalizeCartLine(item);
        const existing = prev.items.find((i) => i.productId === item.productId);
        let next: CartState;
        if (existing) {
          // Merge in PIECES, then re-derive the split: never add a qty onto a stale split.
          next = {
            items: prev.items.map((i) =>
              i.productId === item.productId ? mergeCartLines(i, incoming) : i,
            ),
          };
        } else {
          next = { items: [...prev.items, incoming] };
        }
        if (key) writeCart(key, next);
        return next;
      });
    },
    [key],
  );

  const removeItem = React.useCallback(
    (productId: string) => {
      setCart((prev) => {
        const next = { items: prev.items.filter((i) => i.productId !== productId) };
        if (key) writeCart(key, next);
        return next;
      });
    },
    [key],
  );

  /**
   * Set a line's count in its SELLING UNIT (what the stepper shows and the buyer types): Cases for
   * a boxed CASE line, otherwise pieces. The box split is re-derived, never spread.
   */
  const updateQty = React.useCallback(
    (productId: string, count: number) => {
      if (count <= 0) {
        removeItem(productId);
        return;
      }
      setCart((prev) => {
        const next = {
          items: prev.items.map((i) => (i.productId === productId ? setLineCount(i, count) : i)),
        };
        if (key) writeCart(key, next);
        return next;
      });
    },
    [key, removeItem],
  );

  /** Switch the stepper's unit (Case / Each). `qty` is unchanged, so the money never moves. */
  const setUnit = React.useCallback(
    (productId: string, unit: CartUnit) => {
      setCart((prev) => {
        const next = {
          items: prev.items.map((i) => (i.productId === productId ? setLineUnit(i, unit) : i)),
        };
        if (key) writeCart(key, next);
        return next;
      });
    },
    [key],
  );

  /** The buyer saw the "we corrected N items" banner: drop every `corrected` flag, in state and storage. */
  const acknowledgeCorrections = React.useCallback(() => {
    setCart((prev) => {
      if (!prev.items.some((i) => i.corrected)) return prev;
      const next = {
        items: prev.items.map(({ corrected: _c, ...rest }) => {
          void _c;
          return rest;
        }),
      };
      if (key) writeCart(key, next);
      return next;
    });
  }, [key]);

  /**
   * Once the catalog is loaded, align each line with its pack size (`completeLineFromCatalog`): a line
   * stored WITHOUT one (an older Add from favorites / the dashboard) gets it as whole Cases; a line
   * stored with a DIFFERENT one (the product was repacked) is rebuilt, keeping its Case count or its
   * pieces, and flagged `corrected`.
   */
  const adoptCatalogPacks = React.useCallback(
    (packs: ReadonlyMap<string, number | null | undefined>) => {
      setCart((prev) => {
        let changed = false;
        const items = prev.items.map((i) => {
          const done = completeLineFromCatalog(i, packs.get(i.productId));
          if (done !== i) changed = true;
          return done;
        });
        if (!changed) return prev;
        const next = { items };
        if (key) writeCart(key, next);
        return next;
      });
    },
    [key],
  );

  const clearCart = React.useCallback(() => {
    const next = { items: [] };
    if (key) writeCart(key, next);
    setCart(next);
  }, [key]);

  const getItemQty = React.useCallback(
    (productId: string) => {
      return cart.items.find((i) => i.productId === productId)?.qty ?? 0;
    },
    [cart],
  );

  /** The stepper's count for a product: Cases for a boxed Case line, else pieces; 0 when absent. */
  const getItemCount = React.useCallback(
    (productId: string) => {
      const line = cart.items.find((i) => i.productId === productId);
      return line ? lineCount(line) : 0;
    },
    [cart],
  );

  return {
    items: cart.items,
    addItem,
    removeItem,
    updateQty,
    setUnit,
    acknowledgeCorrections,
    adoptCatalogPacks,
    clearCart,
    getItemQty,
    getItemCount,
    itemCount: cart.items.length,
    totalQty: cart.items.reduce((s, i) => s + i.qty, 0),
  };
}
