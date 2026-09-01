import { create } from "zustand";
import type { CollectionEntry } from "../lib/run-settlement";

interface RunSettlementState {
  collectionsByRun: Record<string, CollectionEntry[]>;
  recordCollection: (runId: string, entry: CollectionEntry) => void;
  clearRun: (runId: string) => void;
}

/**
 * In-memory (non-persisted, matches store/podStore.ts) local tally of cash/
 * check collected during the CURRENT run session. This is a DEVICE-LOCAL
 * record, not a server aggregate — an app kill mid-run or a second device on
 * the same run will under-count. It is NO LONGER the settlement gate: F05
 * (spec R8) moved that to the server-truth `collectedPayments` /
 * `settlementNote` fields on the run payload (see
 * `lib/run-settlement.ts#shouldForceSettlement`), which this store's signal
 * only OR's into for the brief query-staleness window right after a
 * collection, before the run has been refetched. This store remains a
 * per-device echo — the settlement screen's live "collected so far" breakdown
 * — for immediacy, not a record of truth.
 */
export const useRunSettlementStore = create<RunSettlementState>((set) => ({
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
}));
