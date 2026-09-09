import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { userScopedStorage } from "../lib/user-scoped-storage";
import type { CollectionEntry } from "../lib/run-settlement";

interface RunSettlementState {
  collectionsByRun: Record<string, CollectionEntry[]>;
  recordCollection: (runId: string, entry: CollectionEntry) => void;
  clearRun: (runId: string) => void;
  // D1/D3 (cause-ruling.md §3): sign-out (lib/session-teardown.ts) resets this
  // store so a cash tally never survives into the next signed-in driver.
  reset: () => void;
}

/**
 * Per-device local tally of cash/check collected during the CURRENT run
 * session. This is a DEVICE-LOCAL record, not a server aggregate — a second
 * device on the same run will still under-count. It is NOT the settlement
 * gate: F05 (spec R8) moved that to the server-truth `collectedPayments` /
 * `settlementNote` fields on the run payload (see
 * `lib/run-settlement.ts#shouldForceSettlement`), which this store's signal
 * only OR's into for the brief query-staleness window right after a
 * collection, before the run has been refetched. This store remains a
 * per-device echo — the settlement screen's live "collected so far"
 * breakdown — for immediacy, not a record of truth.
 *
 * D3 (cause-ruling.md §3 / REG-B136): persisted (same shape as
 * store/podStore.ts) under a key scoped to the signed-in user
 * (`lib/user-scoped-storage.ts`) — an app kill mid-run used to lose the whole
 * local tally. Hydration is explicit (`skipHydration: true` +
 * `lib/session-hydrate.ts#rehydrateUserScopedStores`) for the reason spelled
 * out in store/podStore.ts.
 */
/**
 * The persist bucket base name — exported for the same reason as
 * `POD_STORE_NAME` in store/podStore.ts.
 */
export const RUN_SETTLEMENT_STORE_NAME = "routeflow-run-settlement";

export const useRunSettlementStore = create<RunSettlementState>()(
  persist(
    (set) => ({
      collectionsByRun: {},
      recordCollection: (runId, entry) =>
        set((s) => ({
          collectionsByRun: {
            ...s.collectionsByRun,
            [runId]: [...(s.collectionsByRun[runId] ?? []), entry],
          },
        })),
      clearRun: (runId) =>
        set((s) => {
          const next = { ...s.collectionsByRun };
          delete next[runId];
          return { collectionsByRun: next };
        }),
      reset: () => set({ collectionsByRun: {} }),
    }),
    {
      name: RUN_SETTLEMENT_STORE_NAME,
      storage: createJSONStorage(() => userScopedStorage),
      skipHydration: true,
      partialize: (state) => ({ collectionsByRun: state.collectionsByRun }),
    },
  ),
);
