import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { userScopedStorage } from "../lib/user-scoped-storage";
import { submittedReturnKey } from "../lib/returns-logic";

interface ReturnSubmissionState {
  submitted: Record<string, true>;
  markSubmitted: (stopId: string, orderId: string) => void;
  // Driver-durability lane (RULINGS.md R1): sign-out (lib/session-teardown.ts)
  // resets this store so a kill-then-logout-then-login-as-someone-else can
  // never surface, or block, the prior driver's return submissions.
  reset: () => void;
}

/**
 * Return-submission dedup set, keyed by `submittedReturnKey(stopId, orderId)`
 * (`lib/returns-logic.ts`). `undeliveredReturnLines` derives return rows/
 * payloads purely from ordered-vs-delivered qty on `deliveryMutations` — it
 * has no awareness of whether a Return record already exists for that line,
 * so the identical payload is re-derived forever. The driver return screen
 * used to track "already submitted this session" as plain `useState` React
 * state, which reset to empty on every mount — an app kill (or even just
 * navigating away and back) mid-route could resubmit an identical return.
 *
 * Built to the exact `store/podStore.ts` recipe: persisted (zustand persist,
 * the same `userScopedStorage` the POD/settlement stores already use) under a
 * key scoped to the signed-in user, `skipHydration: true`, and rehydrated
 * explicitly by `lib/session-hydrate.ts#rehydrateUserScopedStores` once the
 * signed-in user is known.
 *
 * Wired into `app/(driver)/route/stop/[stopId]/return/index.tsx`: `submitted`
 * is read there (~line 144) and fed to `pendingReturnPayloads` to filter out
 * already-submitted orders, and `markSubmitted` is called there (~line 183)
 * for every order that lands or is offline-queued.
 */
export const RETURN_SUBMISSION_STORE_NAME = "routeflow-return-submissions";

export const useReturnSubmissionStore = create<ReturnSubmissionState>()(
  persist(
    (set) => ({
      submitted: {},
      markSubmitted: (stopId, orderId) =>
        set((s) => ({
          submitted: { ...s.submitted, [submittedReturnKey(stopId, orderId)]: true },
        })),
      reset: () => set({ submitted: {} }),
    }),
    {
      name: RETURN_SUBMISSION_STORE_NAME,
      storage: createJSONStorage(() => userScopedStorage),
      skipHydration: true,
      partialize: (state) => ({ submitted: state.submitted }),
    },
  ),
);
