import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

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

interface OfflineQueueState {
  queue: QueuedAction[];
  isOnline: boolean;
  isSyncing: boolean;
  enqueue: (action: Omit<QueuedAction, "id" | "timestamp" | "retries">) => void;
  dequeue: (id: string) => void;
  setOnline: (online: boolean) => void;
  setSyncing: (syncing: boolean) => void;
  incrementRetry: (id: string) => void;
  clearQueue: () => void;
}

export const useOfflineQueue = create<OfflineQueueState>()(
  persist(
    (set) => ({
      queue: [],
      isOnline: true,
      isSyncing: false,

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

      dequeue: (id) =>
        set((state) => ({ queue: state.queue.filter((a) => a.id !== id) })),

      setOnline: (isOnline) => set({ isOnline }),
      setSyncing: (isSyncing) => set({ isSyncing }),

      incrementRetry: (id) =>
        set((state) => ({
          queue: state.queue.map((a) => (a.id === id ? { ...a, retries: a.retries + 1 } : a)),
        })),

      clearQueue: () => set({ queue: [] }),
    }),
    {
      name: "routeflow-offline-queue",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ queue: state.queue }),
    },
  ),
);
