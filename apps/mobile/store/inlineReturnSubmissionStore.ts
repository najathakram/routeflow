import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { userScopedStorage } from "../lib/user-scoped-storage";
import {
  clearNonce,
  getOrCreateNonce as getOrCreateNonceIn,
  type NonceMap,
} from "../lib/inline-return-submit-key";

/**
 * Built to the exact `store/returnSubmissionStore.ts` recipe (itself the `store/podStore.ts`
 * recipe) — persisted (zustand persist, `userScopedStorage`), `skipHydration: true`, rehydrated
 * explicitly by `lib/session-hydrate.ts#rehydrateUserScopedStores` once the signed-in user is
 * known. Deliberately its OWN store, not a reuse of `useReturnSubmissionStore` — the standard
 * return flow's `submitted` map has no equivalent need here (an inline capture's terminal state
 * is just "clear the nonce"; there is no separate "already submitted this order" gate to check
 * before building a payload, unlike `pendingReturnPayloads`), and mixing the two would couple
 * two flows that share no semantics beyond both minting a nonce.
 *
 * All the reducer logic (mint-or-reuse, clear-on-terminal) lives in
 * `lib/inline-return-submit-key.ts` as pure, dependency-free functions — this file is only the
 * zustand+persist wiring, matching this project's mobile-tests-are-pure-logic-only convention
 * (see that file's tests for the property that actually matters: a nonce survives a simulated
 * relaunch and only changes after `markCaptureSettled`).
 */

/** A v4-shaped UUID from `Math.random` — mirrors `returnSubmissionStore.ts#mintNonce` (same
 *  non-cryptographic rationale, kept as its own small copy per that file's own precedent: two
 *  different nonce lifecycles, not a shared refactor). */
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

interface InlineReturnSubmissionState {
  nonces: NonceMap;
  /** Reuses the persisted nonce for `key` (customer+carrying-order) if one exists, else mints
   *  and persists a fresh one. Call this once per capture attempt, before building the request
   *  — never regenerate the nonce yourself between a submit and its retry. */
  getOrCreateNonce: (key: string) => string;
  /** The attempt for `key` reached a terminal state (landed, or a non-retryable refusal) —
   *  clears its nonce so the NEXT attempt for the same customer+order mints a fresh one. */
  markCaptureSettled: (key: string) => void;
  // Driver-durability lane parity (RULINGS.md R1): sign-out (lib/session-teardown.ts) resets
  // this store too, so a kill-then-logout-then-login-as-someone-else can never surface, or
  // block, the prior user's inline-return attempts.
  reset: () => void;
}

export const INLINE_RETURN_SUBMISSION_STORE_NAME = "routeflow-inline-return-submissions";

export const useInlineReturnSubmissionStore = create<InlineReturnSubmissionState>()(
  persist(
    (set, get) => ({
      nonces: {},
      getOrCreateNonce: (key) => {
        const { nonce, nonces } = getOrCreateNonceIn(get().nonces, key, mintNonce);
        if (nonces !== get().nonces) set({ nonces });
        return nonce;
      },
      markCaptureSettled: (key) => set((s) => ({ nonces: clearNonce(s.nonces, key) })),
      reset: () => set({ nonces: {} }),
    }),
    {
      name: INLINE_RETURN_SUBMISSION_STORE_NAME,
      storage: createJSONStorage(() => userScopedStorage),
      skipHydration: true,
      partialize: (state) => ({ nonces: state.nonces }),
    },
  ),
);
