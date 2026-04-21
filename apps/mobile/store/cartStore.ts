import { create } from "zustand";

export interface CartItem {
  productId: string;
  name: string;
  unitPrice: number;
  qty: number;
  unit?: string;
}

interface CartState {
  items: CartItem[];
  add: (item: Omit<CartItem, "qty">) => void;
  remove: (productId: string) => void;
  setQty: (productId: string, qty: number) => void;
  clear: () => void;
  total: () => number;
}

export const useCartStore = create<CartState>()((set, get) => ({
  items: [],

  add: (item) =>
    set((state) => {
      const existing = state.items.find((i) => i.productId === item.productId);
      if (existing) {
        return {
          items: state.items.map((i) =>
            i.productId === item.productId ? { ...i, qty: i.qty + 1 } : i,
          ),
        };
      }
      return { items: [...state.items, { ...item, qty: 1 }] };
    }),

  remove: (productId) =>
    set((state) => ({ items: state.items.filter((i) => i.productId !== productId) })),

  setQty: (productId, qty) =>
    set((state) => {
      if (qty <= 0) return { items: state.items.filter((i) => i.productId !== productId) };
      return {
        items: state.items.map((i) => (i.productId === productId ? { ...i, qty } : i)),
      };
    }),

  clear: () => set({ items: [] }),

  total: () => get().items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0),
}));
