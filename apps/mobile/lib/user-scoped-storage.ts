import AsyncStorage from "@react-native-async-storage/async-storage";
import type { StateStorage } from "zustand/middleware";
import { getStoredUser } from "./auth";

/**
 * Resolve the effective AsyncStorage key for `baseName`, namespaced by the
 * signed-in user (D3 / REG-B136).
 *
 * The key carries the USER ONLY — deliberately no tenant segment. A user id
 * is a DB-global UUID that belongs to exactly one tenant, so the user segment
 * already isolates tenants; adding the tenant slug would only make the key
 * depend on `useTenantStore`, whose `slug` is populated asynchronously by an
 * effect long AFTER the persisted stores are created, so the store would
 * rehydrate from a different key than it writes to and every capture would be
 * lost on an app kill.
 *
 * Falls back to an "anon" bucket when identity is unavailable (before the
 * first login, or a storage read failure) rather than throwing — a POD
 * scratchpad that can't resolve identity yet must degrade, never crash boot.
 */
export async function userScopedStorageKey(baseName: string): Promise<string> {
  let userId: string | null = null;
  try {
    const user = await getStoredUser();
    if (user?.id) userId = user.id;
  } catch {
    // best-effort — fall back to the anon bucket
  }
  return userScopedStorageKeyFor(baseName, userId);
}

/**
 * The pure half of `userScopedStorageKey` — the key for an ALREADY-resolved
 * identity. Sign-out teardown (`lib/session-teardown.ts`) resolves the user id
 * once, BEFORE any token deletion can start, and uses this to address the
 * outgoing user's bucket: the persisted write that `reset()` kicks off is
 * fire-and-forget and resolves its own key one async hop later, by which time
 * `apiLogout()` (or the api-client's session-expired token wipe) may already
 * have removed the tokens, so `getStoredUser()` would answer `null` and the
 * clear would land in the `anon` bucket instead of the user's.
 */
export function userScopedStorageKeyFor(
  baseName: string,
  userId: string | null | undefined,
): string {
  return `${baseName}:${userId ?? "anon"}`;
}

/**
 * Remove a user-scoped persisted blob outright, addressed by a PRE-RESOLVED
 * user id (see `userScopedStorageKeyFor`). Used by sign-out teardown so the
 * outgoing user's POD/settlement scratchpad is gone from disk regardless of
 * where the store's own fire-and-forget persist write ends up landing.
 */
export async function clearUserScopedStorage(
  baseName: string,
  userId: string | null,
): Promise<void> {
  await AsyncStorage.removeItem(userScopedStorageKeyFor(baseName, userId));
}

/**
 * The `StateStorage` behind the user-scoped persisted stores
 * (`store/podStore.ts`, `store/runSettlementStore.ts`). A custom
 * `StateStorage` (not a raw AsyncStorage passthrough like
 * store/mileageStore.ts) precisely so the effective key can be resolved from
 * the CURRENT identity at read/write time — a device that switches drivers
 * never rehydrates the WRONG person's pending photos/signature/cash tally.
 *
 * Every call is wrapped defensively: a storage failure (AsyncStorage
 * unavailable, a platform quirk) must degrade to a no-op, never crash the app
 * — these stores are written to on every sign-out (`reset()`, via
 * lib/session-teardown.ts), so a persistence hiccup there must not take the
 * sign-out down with it.
 *
 * Both consumers set `skipHydration: true` and are rehydrated explicitly by
 * `lib/session-hydrate.ts#rehydrateUserScopedStores` once the signed-in user
 * is known, so the key a store reads from is always the key it wrote to.
 */
export const userScopedStorage: StateStorage = {
  getItem: async (name) => {
    try {
      const key = await userScopedStorageKey(name);
      return await AsyncStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    try {
      const key = await userScopedStorageKey(name);
      await AsyncStorage.setItem(key, value);
    } catch {
      // best-effort — a persistence failure must never crash the app
    }
  },
  removeItem: async (name) => {
    try {
      const key = await userScopedStorageKey(name);
      await AsyncStorage.removeItem(key);
    } catch {
      // best-effort
    }
  },
};
