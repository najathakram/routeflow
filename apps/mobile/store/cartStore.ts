import { create } from "zustand";
import { computeLineSubtotal } from "@routeflow/pricing";

export interface CartItem {
  productId: string;
  name: string;
  unitPrice: number;
  qty: number;
  unit?: string;
  /** Product category — needed so CATEGORY-scoped promotions can match this line. */
  category?: string | null;
  /** Box packaging. When unitsPerBox > 1 the line is boxed: `unitPrice` is the
   *  BOX price and `qty` is the total PIECE count (a whole number of boxes from
   *  the cart, so `pieces` is always 0). Mirrors the web buyer cart so customer
   *  orders are consistently piece-denominated. */
  unitsPerBox?: number | null;
  boxes?: number | null;
  pieces?: number | null;
}

interface CartState {
  items: CartItem[];
  /** Add one selling unit (a box for boxed products, else a piece). */
  add: (item: Omit<CartItem, "qty" | "boxes" | "pieces">) => void;
  /** Step a line by whole selling units (boxes for boxed products). Removes at 0. */
  step: (productId: string, delta: number) => void;
  /** Set a line to an absolute selling-unit count (boxes for boxed products, else
   *  pieces) — used by the typed qty input. Removes the line at <= 0. No-op if
   *  the product isn't in the cart. */
  setUnits: (productId: string, units: number) => void;
  remove: (productId: string) => void;
  clear: () => void;
  total: () => number;
}

/** Whole boxes for a boxed product; else the raw count. Keeps lines box-aligned. */
function boxedFields(unitsPerBox: number | null | undefined, sellingUnits: number) {
  const upb = Number(unitsPerBox ?? 0);
  if (upb > 1) {
    const boxes = Math.max(0, Math.floor(sellingUnits));
    return { boxes, pieces: 0, qty: boxes * upb };
  }
  return { boxes: null, pieces: null, qty: Math.max(0, Math.floor(sellingUnits)) };
}

/** Current selling-unit count of a line (boxes for boxed, else qty). */
function sellingUnitsOf(item: CartItem): number {
  const upb = Number(item.unitsPerBox ?? 0);
  return upb > 1 ? (item.boxes ?? 0) : item.qty;
}

export const useCartStore = create<CartState>()((set, get) => ({
  items: [],

  add: (item) =>
    set((state) => {
      const existing = state.items.find((i) => i.productId === item.productId);
      if (existing) {
        return {
          items: state.items.map((i) =>
            i.productId === item.productId
              ? { ...i, ...boxedFields(i.unitsPerBox, sellingUnitsOf(i) + 1) }
              : i,
          ),
        };
      }
      return {
        items: [...state.items, { ...item, ...boxedFields(item.unitsPerBox, 1) }],
      };
    }),

  step: (productId, delta) =>
    set((state) => {
      const item = state.items.find((i) => i.productId === productId);
      if (!item) return state;
      const next = sellingUnitsOf(item) + delta;
      if (next <= 0) return { items: state.items.filter((i) => i.productId !== productId) };
      return {
        items: state.items.map((i) =>
          i.productId === productId ? { ...i, ...boxedFields(i.unitsPerBox, next) } : i,
        ),
      };
    }),

  setUnits: (productId, units) =>
    set((state) => {
      const item = state.items.find((i) => i.productId === productId);
      if (!item) return state;
      if (units <= 0) return { items: state.items.filter((i) => i.productId !== productId) };
      return {
        items: state.items.map((i) =>
          i.productId === productId ? { ...i, ...boxedFields(i.unitsPerBox, units) } : i,
        ),
      };
    }),

  remove: (productId) =>
    set((state) => ({ items: state.items.filter((i) => i.productId !== productId) })),

  clear: () => set({ items: [] }),

  total: () =>
    get().items.reduce(
      (sum, i) =>
        sum +
        computeLineSubtotal({
          unitPrice: i.unitPrice,
          qty: i.qty,
          boxes: i.boxes ?? null,
          pieces: i.pieces ?? null,
          unitsPerBox: i.unitsPerBox ?? null,
        }),
      0,
    ),
}));
