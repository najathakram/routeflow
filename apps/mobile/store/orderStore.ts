import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface Product {
  id: string;
  name: string;
  pricePerUnit: number | string;
  unit: string;
  [key: string]: unknown;
}

export interface OrderItem {
  productId: string;
  name: string;
  unitPrice: number;
  unit: string;
  quantity: number;
  itemNote?: string;
}

interface OrderState {
  items: OrderItem[];
  isUrgent: boolean;
  notes: string;
  requestedDeliveryDate: string | null;
  editingOrderId: string | null;
  itemNotes: Record<string, string>;
  substitutions: Record<string, string>;
  addItem: (product: Product, quantity: number) => void;
  removeItem: (productId: string) => void;
  updateQuantity: (productId: string, quantity: number) => void;
  setUrgent: (urgent: boolean) => void;
  setNotes: (notes: string) => void;
  setRequestedDeliveryDate: (date: string | null) => void;
  setEditingOrderId: (id: string | null) => void;
  setItemNote: (productId: string, note: string) => void;
  setSubstitution: (productId: string, text: string) => void;
  clearOrder: () => void;
  loadItems: (items: OrderItem[]) => void;
}

export const useOrderStore = create<OrderState>()(
  persist(
    (set) => ({
      items: [],
      isUrgent: false,
      notes: "",
      requestedDeliveryDate: null,
      editingOrderId: null,
      itemNotes: {},
      substitutions: {},

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
                unitPrice: Number(product.pricePerUnit),
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
      setRequestedDeliveryDate: (requestedDeliveryDate) => set({ requestedDeliveryDate }),
      setEditingOrderId: (editingOrderId) => set({ editingOrderId }),
      setItemNote: (productId, note) =>
        set((state) => ({ itemNotes: { ...state.itemNotes, [productId]: note } })),
      setSubstitution: (productId, text) =>
        set((state) => ({ substitutions: { ...state.substitutions, [productId]: text } })),

      clearOrder: () =>
        set({
          items: [],
          isUrgent: false,
          notes: "",
          requestedDeliveryDate: null,
          editingOrderId: null,
          itemNotes: {},
          substitutions: {},
        }),

      loadItems: (items) => set({ items }),
    }),
    {
      name: "routeflow-order",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        items: state.items,
        isUrgent: state.isUrgent,
        notes: state.notes,
        requestedDeliveryDate: state.requestedDeliveryDate,
        itemNotes: state.itemNotes,
        substitutions: state.substitutions,
      }),
    },
  ),
);
