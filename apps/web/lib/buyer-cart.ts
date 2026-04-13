"use client";

import * as React from "react";

export interface CartItem {
  productId: string;
  qty: number;
  name: string;
  unit: string;
  thumbnailUrl?: string | null;
}

interface CartState {
  items: CartItem[];
}

function getCartKey(buyerAccountId: string, sellerSlug: string) {
  return `buyerCart_${buyerAccountId}_${sellerSlug}`;
}

function readCart(key: string): CartState {
  if (typeof window === "undefined") return { items: [] };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { items: [] };
    return JSON.parse(raw) as CartState;
  } catch {
    return { items: [] };
  }
}

function writeCart(key: string, state: CartState) {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, JSON.stringify(state));
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

  // Cross-tab sync
  React.useEffect(() => {
    if (!key) return;
    const handler = (e: StorageEvent) => {
      if (e.key === key) {
        setCart(readCart(key));
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [key]);

  const addItem = React.useCallback(
    (item: CartItem) => {
      setCart((prev) => {
        const existing = prev.items.find((i) => i.productId === item.productId);
        let next: CartState;
        if (existing) {
          next = {
            items: prev.items.map((i) =>
              i.productId === item.productId ? { ...i, qty: i.qty + item.qty } : i,
            ),
          };
        } else {
          next = { items: [...prev.items, item] };
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

  const updateQty = React.useCallback(
    (productId: string, qty: number) => {
      if (qty <= 0) {
        removeItem(productId);
        return;
      }
      setCart((prev) => {
        const next = {
          items: prev.items.map((i) => (i.productId === productId ? { ...i, qty } : i)),
        };
        if (key) writeCart(key, next);
        return next;
      });
    },
    [key, removeItem],
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

  return {
    items: cart.items,
    addItem,
    removeItem,
    updateQty,
    clearCart,
    getItemQty,
    itemCount: cart.items.length,
    totalQty: cart.items.reduce((s, i) => s + i.qty, 0),
  };
}
