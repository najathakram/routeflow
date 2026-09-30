import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { userScopedStorage } from "../lib/user-scoped-storage";
import { submittedReturnKey } from "../lib/returns-logic";

/**
 * A v4-shaped UUID built from `Math.random` — mirrors `lib/order-submit-key.ts`'s
 * `mintCartSessionKey` (same non-cryptographic rationale: this only needs to be
 * unique per submission ATTEMPT, so no `uuid` package / `expo-crypto` dependency).
 * Kept as its own small copy rather than a shared extraction: the two mint
 * different THINGS (a cart session vs a return-submission attempt) with
 * different clear policies, and PR-2's scope fence (RULINGS R7) is the
 * driver-durability lane, not a refactor of the unrelated order-submit path.
 */
function mintNonce(): string {
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) {
    bytes.push(Math.floor(Math.random() * 256));
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

interface ReturnSubmissionState {
  submitted: Record<string, true>;
  markSubmitted: (stopId: string, orderId: string) => void;
  // F1 (independent review, PR-2): returnSubmitKey's stopId+orderId+goods
  // identity is deterministic BY DESIGN (see return-submit-key.ts) so a true
  // retry of ONE attempt — app kill, offline-queue drain, a network timeout —
  // replays onto the same server-side return. But that same determinism
  // collapsed a GENUINELY NEW later return for identical goods (the driver
  // returns 2 units, then later finds 2 more of the same product) into the
  // first one, silently under-crediting the customer. `nonces` gives each
  // PENDING attempt (keyed the same way `submitted` is) a per-attempt value:
  // reused across retries of that attempt (persisted, so it survives an app
  // kill), cleared the moment the attempt reaches a terminal state
  // (markSubmitted below), so the NEXT attempt for the same stop+order mints
  // a fresh one and is never silently absorbed by an old one.
  nonces: Record<string, string>;
  getOrCreateNonce: (key: string) => string;
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
    (set, get) => ({
      submitted: {},
      markSubmitted: (stopId, orderId) =>
        set((s) => {
          const key = submittedReturnKey(stopId, orderId);
          // The attempt this nonce belonged to just reached a terminal state
          // (landed or queued) — clear it so the NEXT attempt for this same
          // stop+order (a genuinely later return) mints a fresh one instead
          // of silently replaying onto this one.
          const { [key]: _cleared, ...restNonces } = s.nonces;
          return {
            submitted: { ...s.submitted, [key]: true },
            nonces: restNonces,
          };
        }),
      nonces: {},
      getOrCreateNonce: (key) => {
        const existing = get().nonces[key];
        if (existing) return existing;
        const minted = mintNonce();
        set((s) => ({ nonces: { ...s.nonces, [key]: minted } }));
        return minted;
      },
      reset: () => set({ submitted: {}, nonces: {} }),
    }),
    {
      name: RETURN_SUBMISSION_STORE_NAME,
      storage: createJSONStorage(() => userScopedStorage),
      skipHydration: true,
      partialize: (state) => ({ submitted: state.submitted, nonces: state.nonces }),
    },
  ),
);
