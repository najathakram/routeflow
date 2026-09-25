import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { userScopedStorage } from "../lib/user-scoped-storage";
import { useOfflineQueue } from "./offlineQueue";

/** Settled returnKeys — GLOBAL tombstones (SA-220; see store/offlineQueue.ts). */
const settledKeys = (): string[] =>
  useOfflineQueue.getState().settledInlineReturnKeys.map((t) => t.key);
import {
  getOrCreateNonce as getOrCreateNonceIn,
  dropSettledNonces,
  noncesFromQueues,
  settleAfterDrain as settleAfterDrainIn,
  settleDirectCapture,
  inlineReturnSubmitKey,
  shouldSettleInlineReturnNonce,
  type InlineReturnCaptureOutcome,
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
 * relaunch and only changes after `settleCapture`).
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
  /** True once THIS user's blob has been rehydrated; `reset()` (sign-out) clears it, and
   *  `persist.hasHydrated()` does not (it stays true across an in-process sign-out). Every
   *  settle path skips its write until true — zustand-persist writes on every set, even
   *  pre-hydration, and would replace the incoming user's blob with {nonces:{}}. Not persisted. */
  hydrated: boolean;
  /** Reuses the persisted nonce for `key` (customer+carrying-order) if one exists, else mints
   *  and persists a fresh one. Call this once per capture attempt, before building the request
   *  — never regenerate the nonce yourself between a submit and its retry. */
  getOrCreateNonce: (key: string) => string;
  /** A capture attempt (identified by its request's own `returnKey`) reached an outcome.
   *  Clears the pair's nonce only on a DEFINITE outcome AND only when the stored nonce is this
   *  attempt's own — a late result from an older attempt never clears a newer one. */
  settleCapture: (
    variables: { customerId: string; orderId: string; returnKey: string },
    outcome: InlineReturnCaptureOutcome | { kind: "queued" },
  ) => void;
  /** SA-091b: the offline-queue drain's equivalent of `settleCapture`, for a batch of
   *  customer/order/nonceSuffix records (built by `inlineReturnDrainSettleRecords`) — each one
   *  settles only when the stored nonce still matches, so a newer attempt's nonce is never
   *  cleared out from under it. See `useNetworkSync.ts`'s post-drain step. */
  settleAfterDrain: (
    records: ReadonlyArray<{ customerId: string; orderId: string; nonceSuffix: string }>,
  ) => void;
  // Driver-durability lane parity (RULINGS.md R1): sign-out (lib/session-teardown.ts) resets
  // this store too, so a kill-then-logout-then-login-as-someone-else can never surface, or
  // block, the prior user's inline-return attempts.
  reset: () => void;
  /** Sign-in: merge in the nonces of THIS user's own queued / failed captures (see
   *  `noncesFromQueues`). Never overrides a nonce already persisted for the pair. */
  seedFromQueues: (
    queue: Parameters<typeof noncesFromQueues>[0],
    failed: Parameters<typeof noncesFromQueues>[1],
    userId: string,
  ) => void;
}

export const INLINE_RETURN_SUBMISSION_STORE_NAME = "routeflow-inline-return-submissions";

export const useInlineReturnSubmissionStore = create<InlineReturnSubmissionState>()(
  persist(
    (set, get) => ({
      nonces: {},
      hydrated: false,
      getOrCreateNonce: (key) => {
        // A stored nonce whose returnKey already reached a terminal outcome must never be reused
        // (a drain that settled BEFORE rehydrate can leave the stale blob in memory): filter first.
        const live = dropSettledNonces(get().nonces, settledKeys());
        if (live !== get().nonces) set({ nonces: live });
        const { nonce, nonces } = getOrCreateNonceIn(get().nonces, key, mintNonce);
        if (nonces !== get().nonces) set({ nonces });
        return nonce;
      },
      settleCapture: (variables, outcome) => {
        // A TERMINAL outcome (landed / definitely refused) also tombstones the key and drops
        // EVERY failed-action record carrying it — so a stale record can never resurrect the key
        // at the next sign-in / launch (which would replay the OLD Return for the next capture).
        if (outcome.kind !== "queued" && shouldSettleInlineReturnNonce(outcome)) {
          useOfflineQueue.getState().settleInlineReturnKey(variables.returnKey);
        }
        // zustand-persist writes on EVERY `set`, even before hydration: a pre-hydration write
        // would replace the user's persisted blob with the (empty) in-memory map. The tombstone
        // above already guards the key (getOrCreateNonce / seed filter it), so skip the nonce
        // write until hydrated.
        if (!get().hydrated) return;
        set((s) => {
          const nonces = settleDirectCapture(s.nonces, variables, outcome);
          return nonces === s.nonces ? s : { nonces };
        });
      },
      settleAfterDrain: (records) => {
        for (const r of records) {
          useOfflineQueue
            .getState()
            .settleInlineReturnKey(
              inlineReturnSubmitKey(
                { customerId: r.customerId, orderId: r.orderId },
                r.nonceSuffix,
              ),
            );
        }
        // Nothing to settle -> no write at all; and never write pre-hydration (see settleCapture:
        // login() sets the user before awaiting rehydrate, so a drain can run first and would
        // overwrite the persisted blob with {nonces:{}}). Tombstones above cover the key.
        if (records.length === 0) return;
        if (!get().hydrated) return;
        set((s) => ({ nonces: settleAfterDrainIn(records, s.nonces) }));
      },
      reset: () => set({ nonces: {}, hydrated: false }),
      seedFromQueues: (queue, failed, userId) => {
        // Bound the persisted tombstones first (age 90d + count cap), then trust the survivors.
        useOfflineQueue.getState().pruneSettledInlineReturnKeys();
        const settled = settledKeys();
        set((s) => ({
          nonces: dropSettledNonces(
            { ...noncesFromQueues(queue, failed, userId, settled), ...s.nonces },
            settled,
          ),
        }));
      },
    }),
    {
      name: INLINE_RETURN_SUBMISSION_STORE_NAME,
      storage: createJSONStorage(() => userScopedStorage),
      skipHydration: true,
      partialize: (state) => ({ nonces: state.nonces }),
      // Runs after every (re)hydration — even when nothing was stored — so the flag flips back on.
      onRehydrateStorage: () => () => {
        useInlineReturnSubmissionStore.setState({ hydrated: true });
      },
    },
  ),
);
