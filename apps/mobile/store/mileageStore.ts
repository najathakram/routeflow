import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MileageEntry {
  runId: string;
  startOdometer: number;
  endOdometer: number | null;
  loggedAt: string; // ISO timestamp
}

interface MileageState {
  // runId -> entry
  entries: Record<string, MileageEntry>;

  logMileage: (runId: string, start: number, end: number | null) => void;
  updateEnd: (runId: string, end: number) => void;
  getEntry: (runId: string) => MileageEntry | null;
  getMiles: (runId: string) => number | null;
  clearEntry: (runId: string) => void;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useMileageStore = create<MileageState>()(
  persist(
    (set, get) => ({
      entries: {},

      logMileage: (runId, start, end) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [runId]: {
              runId,
              startOdometer: start,
              endOdometer: end,
              loggedAt: new Date().toISOString(),
            },
          },
        })),

      updateEnd: (runId, end) =>
        set((state) => {
          const existing = state.entries[runId];
          if (!existing) return state;
          return {
            entries: {
              ...state.entries,
              [runId]: { ...existing, endOdometer: end },
            },
          };
        }),

      getEntry: (runId) => get().entries[runId] ?? null,

      getMiles: (runId) => {
        const entry = get().entries[runId];
        if (!entry || entry.endOdometer == null) return null;
        return Math.max(0, entry.endOdometer - entry.startOdometer);
      },

      clearEntry: (runId) =>
        set((state) => {
          const { [runId]: _, ...entries } = state.entries;
          return { entries };
        }),
    }),
    {
      name: "routeflow-mileage",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
