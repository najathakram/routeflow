import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FailedActionRecord } from "../lib/queue-drain";
import { resolveQueueIdentity, stampQueuedAction, type QueueIdentity } from "../lib/queue-identity";

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
  // REG-B137: who queued this. Stamped at enqueue time from the signed-in
  // identity so a drain under a LATER user on the same device can never
  // replay it (see lib/queue-identity.ts). Optional because entries queued
  // before this shipped — and entries queued while nobody is signed in —
  // carry no stamp; those are adopted once, by the first user to drain them.
  userId?: string;
  tenantId?: string;
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
  /** REG-B137: persist the stamp on a legacy entry adopted by the current user. */
  restampAction: (id: string, identity: QueueIdentity) => void;
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
        set((state) => {
          // REG-B137: stamp the queuing user onto the entry. No signed-in
          // identity (queued from an unauthenticated path) leaves it
          // unstamped — legacy semantics, adopted once at drain time.
          const identity = resolveQueueIdentity();
          const stamped = identity ? stampQueuedAction(action, identity) : action;
          return {
            queue: [
              ...state.queue,
              {
                ...stamped,
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                timestamp: Date.now(),
                retries: 0,
              },
            ],
          };
        }),

      dequeue: (id) => set((state) => ({ queue: state.queue.filter((a) => a.id !== id) })),

      setOnline: (isOnline) => set({ isOnline }),
      setSyncing: (isSyncing) => set({ isSyncing }),

      incrementRetry: (id) =>
        set((state) => ({
          queue: state.queue.map((a) => (a.id === id ? { ...a, retries: a.retries + 1 } : a)),
        })),

      restampAction: (id, identity) =>
        set((state) => ({
          queue: state.queue.map((a) => (a.id === id ? { ...a, ...identity } : a)),
        })),

      clearQueue: () => set({ queue: [] }),

      addFailedAction: (record) =>
        set((state) => {
          // REG-B137: a failure is listed to the user it belongs to. An
          // already-stamped action keeps its own owner — a mismatched entry
          // reaches this list while a DIFFERENT user is signed in, and
          // re-stamping it here would hand that user someone else's failure.
          const identity = record.action.userId === undefined ? resolveQueueIdentity() : null;
          const owned: FailedActionRecord = identity
            ? { ...record, action: { ...record.action, ...identity } }
            : record;
          return {
            // Bounded: this list is persisted and only the operator's review
            // clears it, so an install that never gets tapped must not grow an
            // AsyncStorage blob forever. Keeping the newest MAX_FAILED_ACTIONS
            // is the actionable half — anyone sitting on 50 unacknowledged
            // failures has a bigger problem than the 51st.
            failedActions: [...state.failedActions, owned].slice(-MAX_FAILED_ACTIONS),
          };
        }),

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
