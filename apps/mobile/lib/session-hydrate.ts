import { usePodStore } from "../store/podStore";
import { useRunSettlementStore } from "../store/runSettlementStore";

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
 * `store/podStore.ts` and `store/runSettlementStore.ts` key their storage by
 * user id (`lib/user-scoped-storage.ts`), which cannot be resolved at module
 * evaluation time — zustand's `persist` otherwise hydrates synchronously at
 * store creation, i.e. from the `anon` bucket, so a POD capture written under
 * the real user's key would never come back after an app kill. Both stores
 * therefore set `skipHydration: true` and this function is the ONE explicit
 * hydration point, called from `lib/auth-store.ts` right after the user has
 * been resolved (successful `login()`, and `initialize()` when a stored user
 * is found).
 *
 * Optional-chained and swallowed per store: tests mock these modules with a
 * bare `getState`, and a hydration failure must never block sign-in.
 */
export async function rehydrateUserScopedStores(): Promise<void> {
  await rehydrateOne(usePodStore);
  await rehydrateOne(useRunSettlementStore);
}
