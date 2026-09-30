import { create } from "zustand";

export interface PickedProduct {
  id: string;
  name: string;
  /** Selling unit noun (e.g. "pc", "bottle") — used in boxed-quantity hints. */
  unit?: string;
  /** Pieces per box; > 1 means quantities/costs must be collected per BOX. */
  unitsPerBox?: number | null;
  /** Cost per PIECE (Product.standardCost), never per box. */
  standardCost?: number;
}

interface ProductPickerState {
  selections: Record<string, PickedProduct>;
  setSelection: (key: string, product: PickedProduct) => void;
  clearSelection: (key: string) => void;
  // D1/D3 (cause-ruling.md §3): sign-out (lib/session-teardown.ts) resets this
  // user-scoped store so the next user on this device never sees prior data.
  reset: () => void;
}

export const useProductPickerStore = create<ProductPickerState>((set) => ({
  selections: {},
  setSelection: (key, product) => set((s) => ({ selections: { ...s.selections, [key]: product } })),
  clearSelection: (key) =>
    set((s) => {
      const next = { ...s.selections };
      delete next[key];
      return { selections: next };
    }),
  reset: () => set({ selections: {} }),
}));
