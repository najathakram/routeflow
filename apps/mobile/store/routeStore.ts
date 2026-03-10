import { create } from "zustand";
import { DriverRoute, MOCK_ROUTE } from "../data/driverMockData";

export type ItemDeliveryStatus = "UNRESOLVED" | "DELIVERED" | "PARTIAL" | "REFUSED";

export interface ItemResolution {
  status: ItemDeliveryStatus;
  partialQty?: number;
}

export interface AddedItem {
  id: string;
  name: string;
  qty: number;
}

interface RouteState {
  route: DriverRoute;
  // stopId -> itemId -> resolution
  itemResolutions: Record<string, Record<string, ItemResolution>>;
  // stopId -> driver note
  stopNotes: Record<string, string>;
  // stopId -> extra items driver added
  addedItems: Record<string, AddedItem[]>;

  setItemResolution: (
    stopId: string,
    itemId: string,
    resolution: ItemResolution,
  ) => void;
  setStopNote: (stopId: string, note: string) => void;
  addStopItem: (stopId: string, name: string, qty: number) => void;
  startRoute: () => void;
  completeStop: (stopId: string) => void;
}

export const useRouteStore = create<RouteState>((set, get) => ({
  route: MOCK_ROUTE,
  itemResolutions: {},
  stopNotes: {},
  addedItems: {},

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

  addStopItem: (stopId, name, qty) =>
    set((state) => {
      const existing = state.addedItems[stopId] ?? [];
      return {
        addedItems: {
          ...state.addedItems,
          [stopId]: [
            ...existing,
            { id: `added-${Date.now()}`, name, qty },
          ],
        },
      };
    }),

  startRoute: () =>
    set((state) => {
      const firstPending = state.route.stops.find((s) => s.status === "PENDING");
      if (!firstPending) return state;
      return {
        route: {
          ...state.route,
          stops: state.route.stops.map((s) =>
            s.id === firstPending.id ? { ...s, status: "IN_PROGRESS" } : s,
          ),
        },
      };
    }),

  completeStop: (stopId) =>
    set((state) => {
      const stops = state.route.stops.map((s) =>
        s.id === stopId ? { ...s, status: "COMPLETED" as const } : s,
      );
      // Auto-start the next pending stop
      const nextPending = stops.find((s) => s.status === "PENDING");
      const finalStops = nextPending
        ? stops.map((s) =>
            s.id === nextPending.id ? { ...s, status: "IN_PROGRESS" as const } : s,
          )
        : stops;
      const allDone = finalStops.every(
        (s) => s.status === "COMPLETED" || s.status === "SKIPPED",
      );
      return {
        route: {
          ...state.route,
          status: allDone ? "COMPLETED" : "ACTIVE",
          stops: finalStops,
        },
      };
    }),
}));

// ─── Selectors ─────────────────────────────────────────────────────────────────

export function selectCompletedCount(state: RouteState) {
  return state.route.stops.filter((s) => s.status === "COMPLETED").length;
}

export function selectCurrentStop(state: RouteState) {
  return state.route.stops.find((s) => s.status === "IN_PROGRESS") ?? null;
}

export function selectStopResolutions(state: RouteState, stopId: string) {
  return state.itemResolutions[stopId] ?? {};
}

export function selectAllItemsResolved(state: RouteState, stopId: string) {
  const stop = state.route.stops.find((s) => s.id === stopId);
  if (!stop) return false;
  const resolutions = state.itemResolutions[stopId] ?? {};
  const addedItems = state.addedItems[stopId] ?? [];
  const allOriginalResolved = stop.items.every(
    (item) =>
      resolutions[item.id] && resolutions[item.id].status !== "UNRESOLVED",
  );
  const allAddedResolved = addedItems.every(
    (item) =>
      resolutions[item.id] && resolutions[item.id].status !== "UNRESOLVED",
  );
  return allOriginalResolved && allAddedResolved;
}
