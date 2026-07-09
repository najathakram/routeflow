import { create } from "zustand";

export interface PodEntry {
  photoUrls?: string[];
  signatureUri?: string;
  note?: string;
  // Phase 4 (W7b): regulated-delivery capture, held locally until the stop is
  // completed (folded into the complete-stop payload), then cleared.
  ageVerified?: boolean;
  identityVerified?: boolean;
  identityType?: string | null;
}

interface PodState {
  pods: Record<string, PodEntry>;
  setPhotos: (stopId: string, photoUrls: string[]) => void;
  setSignature: (stopId: string, uri: string | undefined) => void;
  setNote: (stopId: string, note: string) => void;
  setRegulated: (
    stopId: string,
    patch: Partial<Pick<PodEntry, "ageVerified" | "identityVerified" | "identityType">>,
  ) => void;
  clear: (stopId: string) => void;
}

/**
 * In-memory POD scratchpad keyed by stop id. Photos/signature/note and the W7b
 * age/identity checks captured by the driver are held here until the stop is
 * completed, then cleared.
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
  setRegulated: (stopId, patch) =>
    set((s) => ({
      pods: { ...s.pods, [stopId]: { ...(s.pods[stopId] ?? {}), ...patch } },
    })),
  clear: (stopId) =>
    set((s) => {
      const next = { ...s.pods };
      delete next[stopId];
      return { pods: next };
    }),
}));
