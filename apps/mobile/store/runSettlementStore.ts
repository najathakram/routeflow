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
 * record, not a server aggregate — no backend endpoint exists to fetch "all
 * payments for run X" independent of what THIS device recorded (see plan
 * §2.3 and the adjacent §3 finding: driver payments don't even reliably
 * persist server-side today), so an app kill mid-run or a second device on
 * the same run will under-count. Accepted, documented limitation for a
 * mobile-only, additive-only increment.
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
