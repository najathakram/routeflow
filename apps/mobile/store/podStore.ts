import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { userScopedStorage } from "../lib/user-scoped-storage";

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
  // D1/D3 (cause-ruling.md §3): sign-out (lib/session-teardown.ts) resets this
  // store so a kill-then-logout-then-login-as-someone-else can never surface
  // the prior driver's in-progress captures.
  reset: () => void;
}

/**
 * POD scratchpad keyed by stop id. Photos/signature/note and the W7b
 * age/identity checks captured by the driver are held here until the stop is
 * completed, then cleared.
 *
 * D3 (cause-ruling.md §3 / REG-B136): persisted (zustand persist, same
 * storage the offline queue already uses) under a key scoped to the
 * signed-in user (`lib/user-scoped-storage.ts`) — an in-memory-only store
 * lost every captured photo/signature on an app kill mid-route. Hydration is
 * deliberately NOT automatic (`skipHydration: true`): the user id behind the
 * key is only resolvable asynchronously, so `lib/auth-store.ts` calls
 * `lib/session-hydrate.ts#rehydrateUserScopedStores` once the signed-in user
 * is known — otherwise the store would rehydrate from the `anon` bucket it
 * never wrote to. On relaunch the stop screen then reconciles against what
 * the server already holds (`lib/pod-reconcile.ts#pendingPodArtifacts`)
 * before re-attaching, so a kill-then-relaunch never re-sends a duplicate
 * photo.
 */
/**
 * The persist bucket base name. Exported so sign-out teardown
 * (`lib/session-teardown.ts`) can address this store's persisted blob by the
 * SAME literal the persist config writes under — defined once, here.
 */
export const POD_STORE_NAME = "routeflow-pod-store";

export const usePodStore = create<PodState>()(
  persist(
    (set) => ({
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
      reset: () => set({ pods: {} }),
    }),
    {
      name: POD_STORE_NAME,
      storage: createJSONStorage(() => userScopedStorage),
      skipHydration: true,
      partialize: (state) => ({ pods: state.pods }),
    },
  ),
);
