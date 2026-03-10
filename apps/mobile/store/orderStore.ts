import { create } from "zustand";
import { Product } from "../data/mockData";

export interface OrderItem {
  productId: string;
  name: string;
  unitPrice: number;
  unit: string;
  quantity: number;
}

interface OrderState {
  items: OrderItem[];
  isUrgent: boolean;
  notes: string;
  addItem: (product: Product, quantity: number) => void;
  removeItem: (productId: string) => void;
  updateQuantity: (productId: string, quantity: number) => void;
  setUrgent: (urgent: boolean) => void;
  setNotes: (notes: string) => void;
  clearOrder: () => void;
}

export const useOrderStore = create<OrderState>((set) => ({
  items: [],
  isUrgent: false,
  notes: "",

  addItem: (product, quantity) =>
    set((state) => {
      const existing = state.items.find((i) => i.productId === product.id);
      if (existing) {
        return {
          items: state.items.map((i) =>
            i.productId === product.id
              ? { ...i, quantity: i.quantity + quantity }
              : i,
          ),
        };
      }
      return {
        items: [
          ...state.items,
          {
            productId: product.id,
            name: product.name,
            unitPrice: product.price,
            unit: product.unit,
            quantity,
          },
        ],
      };
    }),

  removeItem: (productId) =>
    set((state) => ({
      items: state.items.filter((i) => i.productId !== productId),
    })),

  updateQuantity: (productId, quantity) =>
    set((state) => ({
      items:
        quantity <= 0
          ? state.items.filter((i) => i.productId !== productId)
          : state.items.map((i) =>
              i.productId === productId ? { ...i, quantity } : i,
            ),
    })),

  setUrgent: (isUrgent) => set({ isUrgent }),
  setNotes: (notes) => set({ notes }),
  clearOrder: () => set({ items: [], isUrgent: false, notes: "" }),
}));