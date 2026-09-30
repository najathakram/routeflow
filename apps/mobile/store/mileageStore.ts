import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
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
  // D1/D3 (cause-ruling.md §3): sign-out (lib/session-teardown.ts) resets this
  // user-scoped store so the next user on this device never sees prior data.
  reset: () => void;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

/**
 * Same AsyncStorage, same key — every call wrapped so a storage failure
 * degrades to a no-op instead of an unhandled rejection. This store is now
 * written to on every sign-out (`reset()`, via lib/session-teardown.ts), and a
 * persistence hiccup there must not take the sign-out down with it — the same
 * reason store/podStore.ts wraps its own writes.
 */
const safeAsyncStorage: StateStorage = {
  getItem: async (name) => {
    try {
      return await AsyncStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    try {
      await AsyncStorage.setItem(name, value);
    } catch {
      // best-effort — a persistence failure must never crash the app
    }
  },
  removeItem: async (name) => {
    try {
      await AsyncStorage.removeItem(name);
    } catch {
      // best-effort
    }
  },
};

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

      reset: () => set({ entries: {} }),
    }),
    {
      name: "routeflow-mileage",
      storage: createJSONStorage(() => safeAsyncStorage),
    },
  ),
);
