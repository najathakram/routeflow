import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FailedActionRecord } from "../lib/queue-drain";
import {
  pruneSettledKeys,
  referencedReturnKeys,
  type SettledKey,
} from "../lib/inline-return-submit-key";
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
const MAX_FAILED_ACTIONS = 50;

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
  /** GLOBAL tombstones (SA-220: a user-scoped list would bring back a settled attempt after a
   *  driver hand-off — legacy queue entries are ADOPTED by the next user, REG-B137) of inline-return captures that reached a TERMINAL outcome (landed / definitely
   *  refused). The sign-in nonce rebuild skips these, so a stale failed-action record can never
   *  resurrect a settled key (Opus re-review of #1270). Persisted with the queue (which sign-out
   *  deliberately leaves alone) so they survive sign-out AND relaunch; a returnKey is unique per
   *  attempt so a tombstone can never suppress a later capture. Pruned by age (90 days) and a
   *  count cap at seed time (`pruneSettledInlineReturnKeys`) — never unbounded (SA-206). */
  settledInlineReturnKeys: SettledKey[];
  /** Age + count prune, never evicting a key the queue / failed-actions list still references. */
  pruneSettledInlineReturnKeys: (now?: number) => void;
  /** A capture attempt (its `returnKey`) reached a terminal outcome: tombstone the key AND drop
   *  EVERY failed-action record carrying it (direct- and drain-origin alike) in ONE update, pruning
   *  on every insert. */
  settleInlineReturnKey: (returnKey: string) => void;
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

      settledInlineReturnKeys: [],
      pruneSettledInlineReturnKeys: (now = Date.now()) =>
        set((state) => {
          const pruned = pruneSettledKeys(
            state.settledInlineReturnKeys,
            now,
            referencedReturnKeys(state.queue, state.failedActions),
          );
          return pruned === state.settledInlineReturnKeys
            ? state
            : { settledInlineReturnKeys: [...pruned] };
        }),
      settleInlineReturnKey: (returnKey) =>
        set((state) => {
          const failedActions = state.failedActions.filter(
            (f) =>
              !(
                f.action.endpoint === "/returns/inline/capture" &&
                (f.action.body as { returnKey?: string } | undefined)?.returnKey === returnKey
              ),
          );
          const now = Date.now();
          const next = [
            ...state.settledInlineReturnKeys.filter((t) => t.key !== returnKey),
            { key: returnKey, at: now },
          ];
          return {
            failedActions,
            // prune on EVERY insert (the just-settled key is protected by being newest)
            settledInlineReturnKeys: [
              ...pruneSettledKeys(next, now, referencedReturnKeys(state.queue, failedActions)),
            ],
          };
        }),
    }),
    {
      name: "routeflow-offline-queue",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        queue: state.queue,
        failedActions: state.failedActions,
        settledInlineReturnKeys: state.settledInlineReturnKeys,
      }),
    },
  ),
);

/** Badge count selector — failures awaiting operator attention (R6). */
export const selectFailedActionCount = (state: OfflineQueueState): number =>
  state.failedActions.length;
