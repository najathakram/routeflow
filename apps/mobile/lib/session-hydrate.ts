import { usePodStore } from "../store/podStore";
import { useRunSettlementStore } from "../store/runSettlementStore";
import { useStopCartStore } from "../store/stopCartStore";
import { useReturnSubmissionStore } from "../store/returnSubmissionStore";
import { useInlineReturnSubmissionStore } from "../store/inlineReturnSubmissionStore";
import { useOfflineQueue } from "../store/offlineQueue";
import { getStoredUser } from "./auth";

interface MaybePersisted {
  persist?: { rehydrate?: () => void | Promise<void> };
}

async function rehydrateOne(store: unknown): Promise<void> {
  try {
    await (store as MaybePersisted).persist?.rehydrate?.();
  } catch {
    // best-effort — a rehydration failure must never block sign-in
  }
}

/**
 * D3 (cause-ruling.md §3 / REG-B136) — rehydrate the user-scoped persisted
 * stores now that the signed-in user is known.
 *
 * `store/podStore.ts`, `store/runSettlementStore.ts`, `store/stopCartStore.ts`,
 * `store/returnSubmissionStore.ts` (driver-durability lane) and
 * `store/inlineReturnSubmissionStore.ts` (Returns Inside Order Creation, PR 3) key their
 * storage by user id (`lib/user-scoped-storage.ts`), which cannot be resolved
 * at module evaluation time — zustand's `persist` otherwise hydrates
 * synchronously at store creation, i.e. from the `anon` bucket, so a capture
 * written under the real user's key would never come back after an app kill.
 * All four stores therefore set `skipHydration: true` and this function is
 * the ONE explicit hydration point, called from `lib/auth-store.ts` right
 * after the user has been resolved (successful `login()`, and `initialize()`
 * when a stored user is found).
 *
 * Optional-chained and swallowed per store: tests mock these modules with a
 * bare `getState`, and a hydration failure must never block sign-in.
 */
export async function rehydrateUserScopedStores(): Promise<void> {
  // The inline-return store goes FIRST: a queue drain can run as soon as the user is set, and it
  // must not write over the incoming user's blob while four other stores hydrate (Opus round 2).
  await rehydrateOne(useInlineReturnSubmissionStore);
  await rehydrateOne(usePodStore);
  await rehydrateOne(useRunSettlementStore);
  await rehydrateOne(useStopCartStore);
  await rehydrateOne(useReturnSubmissionStore);
  await seedInlineReturnNonces();
}

/**
 * Sign-out empties the inline-return nonces (never carried across users); sign-in rebuilds the
 * signed-in user's from THEIR OWN offline queue + failed-actions list, so a queued or
 * uncertain-failed capture's key survives a sign-out/sign-in without ever leaking to another
 * user. Best-effort like every hydration step.
 */
async function seedInlineReturnNonces(): Promise<void> {
  try {
    const user = await getStoredUser();
    if (!user?.id) return;
    const { queue, failedActions } = useOfflineQueue.getState();
    (
      useInlineReturnSubmissionStore.getState() as {
        seedFromQueues?: (q: unknown, f: unknown, u: string) => void;
      }
    ).seedFromQueues?.(queue ?? [], failedActions ?? [], user.id);
  } catch {
    // best-effort
  }
}
