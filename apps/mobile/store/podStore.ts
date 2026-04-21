import { create } from "zustand";

interface PodState {
  pods: Record<string, { photoUrls?: string[]; signatureUri?: string; note?: string }>;
  setPhotos: (stopId: string, photoUrls: string[]) => void;
  setSignature: (stopId: string, uri: string | undefined) => void;
  setNote: (stopId: string, note: string) => void;
  clear: (stopId: string) => void;
}

/**
 * In-memory POD scratchpad keyed by stop id. Photos/signature/note captured
 * by the driver are held here until the stop is completed (the values get
 * folded into `useCompleteStop`'s payload), then cleared.
 */
export const usePodStore = create<PodState>((set) => ({
  pods: {},
  setPhotos: (stopId, photoUrls) =>
    set((s) => ({
      pods: { ...s.pods, [stopId]: { ...(s.pods[stopId] ?? {}), photoUrls } },
    })),
  setSignature: (stopId, signatureUri) =>
    set((s) => ({
      pods: { ...s.pods, [stopId]: { ...(s.pods[stopId] ?? {}), signatureUri } },
    })),
  setNote: (stopId, note) =>
    set((s) => ({
      pods: { ...s.pods, [stopId]: { ...(s.pods[stopId] ?? {}), note } },
    })),
  clear: (stopId) =>
    set((s) => {
      const next = { ...s.pods };
      delete next[stopId];
      return { pods: next };
    }),
}));
