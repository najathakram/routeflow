import { create } from "zustand";

interface DeliveryPlanState {
  /** stopId -> { orderItemId -> delivered qty (piece-equivalent) }. Only touched lines are present. */
  plansByStop: Record<string, Record<string, number>>;
  setQty: (stopId: string, orderItemId: string, qty: number) => void;
  clearStop: (stopId: string) => void;
}

/**
 * In-memory (non-persisted, matches store/podStore.ts) scratchpad for the
 * short-pick screen's per-line delivered-qty overrides, handed off to
 * payment.tsx's closeStop(). Cleared once the stop is completed.
 */
export const useDeliveryPlanStore = create<DeliveryPlanState>((set) => ({
  plansByStop: {},
  setQty: (stopId, orderItemId, qty) =>
    set((s) => ({
      plansByStop: {
        ...s.plansByStop,
        [stopId]: { ...(s.plansByStop[stopId] ?? {}), [orderItemId]: qty },
      },
    })),
  clearStop: (stopId) =>
    set((s) => {
      const next = { ...s.plansByStop };
      delete next[stopId];
      return { plansByStop: next };
    }),
}));
