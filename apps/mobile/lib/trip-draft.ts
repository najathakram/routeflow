import { create } from "zustand";

/**
 * Selected order ids handed from the orders-list multi-select
 * (`(operator)/(tabs)/orders/index.tsx`) to the ad-hoc trip builder
 * (`(operator)/trips/new.tsx`).
 *
 * In-memory only — unlike web's `sessionStorage`-backed draft
 * (`apps/web/lib/trip-draft.ts`), mobile has no page-reload boundary between
 * the two screens (both live inside the same JS runtime under expo-router), so
 * a plain zustand store is enough; nothing needs a TTL or to survive an app
 * restart. `clear()` is called once, right after a trip is successfully
 * dispatched.
 */
interface TripDraftState {
  orderIds: string[];
  setOrderIds: (ids: string[]) => void;
  clear: () => void;
}

export const useTripDraftStore = create<TripDraftState>((set) => ({
  orderIds: [],
  setOrderIds: (orderIds) => set({ orderIds }),
  clear: () => set({ orderIds: [] }),
}));
