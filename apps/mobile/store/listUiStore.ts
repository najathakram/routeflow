import { create } from "zustand";
import type { ListUiSnapshot } from "../lib/list-ui-snapshot";

interface ListUiState {
  snapshots: Record<string, ListUiSnapshot<any>>;
  saveListUi: (key: string, snapshot: ListUiSnapshot<any>) => void;
  clearListUi: (key: string) => void;
}

/**
 * In-memory (non-persisted, matches store/podStore.ts / delivery-plan-store.ts)
 * list-UI scratchpad keyed by list id ("operator-products" today; the key
 * scheme is deliberately generic so another list screen can adopt it later).
 * Nothing here survives a cold start — see lib/list-ui-snapshot.ts for why
 * that is by design, not a gap.
 */
export const useListUiStore = create<ListUiState>((set) => ({
  snapshots: {},
  saveListUi: (key, snapshot) => set((s) => ({ snapshots: { ...s.snapshots, [key]: snapshot } })),
  clearListUi: (key) =>
    set((s) => {
      const next = { ...s.snapshots };
      delete next[key];
      return { snapshots: next };
    }),
}));

/** List id for the operator products screen (`app/(operator)/products/index.tsx`). */
export const OPERATOR_PRODUCTS_LIST_ID = "operator-products";

/** Typed one-shot read outside a subscription — for a lazy `useState` initializer. */
export function getListUiSnapshot<TFilters>(key: string): ListUiSnapshot<TFilters> | undefined {
  return useListUiStore.getState().snapshots[key] as ListUiSnapshot<TFilters> | undefined;
}
