import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FailedActionRecord } from "../lib/queue-drain";

export interface QueuedAction {
  id: string;
  endpoint: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  // Headers worth preserving across replay — currently only Idempotency-Key
  // (RF-019 / BUG-DRV1-3). Auth is re-attached by the request interceptor.
  headers?: Record<string, string>;
  timestamp: number;
  retries: number;
}

/** Upper bound on the persisted failure list (see addFailedAction). */
export const MAX_FAILED_ACTIONS = 50;

interface OfflineQueueState {
  queue: QueuedAction[];
  isOnline: boolean;
  isSyncing: boolean;
  // REG-B143 / REG-B111: a 4xx or a retry-exhausted entry is never just
  // dequeued — it lands here instead, with a reason, so it stays visible to
  // the operator instead of evaporating with zero signal.
  failedActions: FailedActionRecord[];
  enqueue: (action: Omit<QueuedAction, "id" | "timestamp" | "retries">) => void;
  dequeue: (id: string) => void;
  setOnline: (online: boolean) => void;
  setSyncing: (syncing: boolean) => void;
  incrementRetry: (id: string) => void;
  clearQueue: () => void;
  addFailedAction: (record: FailedActionRecord) => void;
  clearFailedAction: (actionId: string) => void;
  clearFailedActions: () => void;
}

export const useOfflineQueue = create<OfflineQueueState>()(
  persist(
    (set) => ({
      queue: [],
      isOnline: true,
      isSyncing: false,
      failedActions: [],

      enqueue: (action) =>
        set((state) => ({
          queue: [
            ...state.queue,
            {
              ...action,
              id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              timestamp: Date.now(),
              retries: 0,
            },
          ],
        })),

      dequeue: (id) => set((state) => ({ queue: state.queue.filter((a) => a.id !== id) })),

      setOnline: (isOnline) => set({ isOnline }),
      setSyncing: (isSyncing) => set({ isSyncing }),

      incrementRetry: (id) =>
        set((state) => ({
          queue: state.queue.map((a) => (a.id === id ? { ...a, retries: a.retries + 1 } : a)),
        })),

      clearQueue: () => set({ queue: [] }),

      addFailedAction: (record) =>
        set((state) => ({
          // Bounded: this list is persisted and only the operator's review
          // clears it, so an install that never gets tapped must not grow an
          // AsyncStorage blob forever. Keeping the newest MAX_FAILED_ACTIONS
          // is the actionable half — anyone sitting on 50 unacknowledged
          // failures has a bigger problem than the 51st.
          failedActions: [...state.failedActions, record].slice(-MAX_FAILED_ACTIONS),
        })),

      clearFailedAction: (actionId) =>
        set((state) => ({
          failedActions: state.failedActions.filter((f) => f.action.id !== actionId),
        })),

      clearFailedActions: () => set({ failedActions: [] }),
    }),
    {
      name: "routeflow-offline-queue",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ queue: state.queue, failedActions: state.failedActions }),
    },
  ),
);

/** Badge count selector — failures awaiting operator attention (R6). */
export const selectFailedActionCount = (state: OfflineQueueState): number =>
  state.failedActions.length;
