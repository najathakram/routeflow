import { create } from "zustand";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ItemDeliveryStatus = "UNRESOLVED" | "DELIVERED" | "PARTIAL" | "REFUSED";

export interface ItemResolution {
  status: ItemDeliveryStatus;
  partialQty?: number;
}

export interface AddedItem {
  id: string;
  productId: string;
  name: string;
  qty: number;
}

// ─── State ────────────────────────────────────────────────────────────────────

interface RouteState {
  // Active run id — set when driver enters a route run
  activeRunId: string | null;

  // stopId -> itemId -> resolution
  itemResolutions: Record<string, Record<string, ItemResolution>>;

  // stopId -> driver note
  stopNotes: Record<string, string>;

  // stopId -> extra items driver added (add-ons not on the original order)
  addedItems: Record<string, AddedItem[]>;

  setActiveRunId: (runId: string | null) => void;
  setItemResolution: (stopId: string, itemId: string, resolution: ItemResolution) => void;
  setStopNote: (stopId: string, note: string) => void;
  addStopItem: (stopId: string, productId: string, name: string, qty: number) => void;
  removeAddedItem: (stopId: string, itemId: string) => void;
  clearStop: (stopId: string) => void;
  clearRun: () => void;
}

export const useRouteStore = create<RouteState>((set) => ({
  activeRunId: null,
  itemResolutions: {},
  stopNotes: {},
  addedItems: {},

  setActiveRunId: (runId) => set({ activeRunId: runId }),

  setItemResolution: (stopId, itemId, resolution) =>
    set((state) => ({
      itemResolutions: {
        ...state.itemResolutions,
        [stopId]: {
          ...state.itemResolutions[stopId],
          [itemId]: resolution,
        },
      },
    })),

  setStopNote: (stopId, note) =>
    set((state) => ({ stopNotes: { ...state.stopNotes, [stopId]: note } })),

  addStopItem: (stopId, productId, name, qty) =>
    set((state) => {
      const existing = state.addedItems[stopId] ?? [];
      const id = `added-${Date.now()}`;
      return {
        addedItems: {
          ...state.addedItems,
          [stopId]: [...existing, { id, productId, name, qty }],
        },
        // Auto-initialise as DELIVERED so Complete Stop stays enabled
        itemResolutions: {
          ...state.itemResolutions,
          [stopId]: {
            ...state.itemResolutions[stopId],
            [id]: { status: "DELIVERED" as const },
          },
        },
      };
    }),

  removeAddedItem: (stopId, itemId) =>
    set((state) => ({
      addedItems: {
        ...state.addedItems,
        [stopId]: (state.addedItems[stopId] ?? []).filter((i) => i.id !== itemId),
      },
    })),

  clearStop: (stopId) =>
    set((state) => {
      const { [stopId]: _res, ...itemResolutions } = state.itemResolutions;
      const { [stopId]: _note, ...stopNotes } = state.stopNotes;
      const { [stopId]: _added, ...addedItems } = state.addedItems;
      return { itemResolutions, stopNotes, addedItems };
    }),

  clearRun: () =>
    set({ activeRunId: null, itemResolutions: {}, stopNotes: {}, addedItems: {} }),
}));

// ─── Selectors ────────────────────────────────────────────────────────────────

export function selectStopResolutions(state: RouteState, stopId: string) {
  return state.itemResolutions[stopId] ?? {};
}

export function selectAllItemsResolved(
  state: RouteState,
  stopId: string,
  orderItemIds: string[],
): boolean {
  const resolutions = state.itemResolutions[stopId] ?? {};
  const addedItems = state.addedItems[stopId] ?? [];
  const allOriginalResolved = orderItemIds.every(
    (id) => resolutions[id] && resolutions[id].status !== "UNRESOLVED",
  );
  const allAddedResolved = addedItems.every(
    (item) => resolutions[item.id] && resolutions[item.id].status !== "UNRESOLVED",
  );
  return allOriginalResolved && allAddedResolved;
}
