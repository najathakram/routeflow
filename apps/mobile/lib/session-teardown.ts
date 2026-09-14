import AsyncStorage from "@react-native-async-storage/async-storage";
import { queryClient } from "./query-client";
import { stopLocationTracking } from "./location-tracker";
import { getStoredUser } from "./auth";
import { clearUserScopedStorage } from "./user-scoped-storage";
import { editItemsSnapshotUserPrefix } from "./edit-items-draft";
import { POD_STORE_NAME, usePodStore } from "../store/podStore";
import { RUN_SETTLEMENT_STORE_NAME, useRunSettlementStore } from "../store/runSettlementStore";
import { useMileageStore } from "../store/mileageStore";
import { useRouteStore } from "../store/routeStore";
import { useDeliveryPlanStore } from "../store/delivery-plan-store";
import { useListUiStore } from "../store/listUiStore";
import { useProductPickerStore } from "../store/productPickerStore";
import { STOP_CART_STORE_NAME, useStopCartStore } from "../store/stopCartStore";

export type TeardownReason = "logout" | "session-expired" | "cross-tab";

export interface TeardownOptions {
  reason?: TeardownReason;
  /**
   * The user whose session is ending, supplied by the caller while it still
   * knows (both call sites read `useAuthStore`'s in-memory user). Falls back
   * to the stored user, resolved as the FIRST thing teardown does — see the
   * persisted-clear note in the function body.
   */
  userId?: string | null;
}

/**
 * D1 (cause-ruling.md §3) — the ONE place every user-scoped side effect of
 * ending a session lands. Called by `useAuthStore.logout()` BEFORE
 * `apiLogout()` (tokens are still valid at that point) and by the
 * session-expired path (lib/auth-store.ts `registerStaffSessionExpiredHandler`
 * callback).
 *
 * Covers:
 *  - B150 — background GPS kept tracking after sign-out. `stopLocationTracking`
 *    is called unconditionally, with no role/realm gate, so BOTH the driver
 *    realm (which already stopped tracking on route completion elsewhere) and
 *    the operator realm (which had no stop site at all) go through the same
 *    call.
 *  - B140 — the query cache and the 8 user-scoped stores below survived a
 *    sign-out, so the next login on the same device could see the prior
 *    user's data flash on screen. (stopCartStore joined the original 7 —
 *    same reset()/persisted-blob pattern, same reason.)
 *  - B136 keyspace — the order-item editor's staged-edit snapshot is one key
 *    PER ORDER (`rf.edit-items.v1:<userId>:<orderId>`), not a single blob, so
 *    it cannot be addressed by a `clearUserScopedStorage(NAME, userId)` call.
 *    Step (6) sweeps the outgoing user's whole prefix instead (RULINGS R1).
 *
 * Deliberately NOT touched here:
 *  - The tenant store (Q2 — a shared-tablet branded login must survive a
 *    sign-out; see `store/offlineQueue.ts` is likewise left alone below).
 *  - The offline queue. D2 stamps every entry with its owning user at
 *    enqueue time, and sign-out must never flush or clear it — flushing on
 *    sign-out is a network gamble, and identity-stamped entries stay
 *    correctly attributed to the user who queued them regardless of who is
 *    signed in when the drain next runs.
 */
export async function teardownUserSession(options: TeardownOptions = {}): Promise<void> {
  // (0) Resolve the outgoing identity FIRST, before anything downstream can
  // delete the tokens (`apiLogout()` on the logout path; the api-client's own
  // wipe, which has already happened, on the session-expired path). Every
  // persisted clear below is addressed with this id.
  const userId = options.userId ?? (await getStoredUser())?.id ?? null;

  // (1) Stop background location tracking — both realms, unconditionally.
  await stopLocationTracking();

  // (2) Offline queue: intentionally left untouched — see the file header.

  // (3) Let in-flight mutations settle, then drop the query cache.
  await queryClient.cancelQueries();
  queryClient.clear();

  // (4) Reset the 8 user-scoped stores. All 8 expose a `reset()`;
  // `resetIfPresent` stays a defensive no-op so a store that ever loses one
  // can never turn a sign-out into a crash.
  resetIfPresent(usePodStore.getState());
  resetIfPresent(useRunSettlementStore.getState());
  resetIfPresent(useMileageStore.getState());
  resetIfPresent(useRouteStore.getState());
  resetIfPresent(useDeliveryPlanStore.getState());
  resetIfPresent(useListUiStore.getState());
  resetIfPresent(useProductPickerStore.getState());
  resetIfPresent(useStopCartStore.getState());

  // (5) Remove the three PERSISTED user-scoped blobs by the id resolved in (0).
  // The `reset()` calls above kick off zustand-persist writes that are
  // fire-and-forget and resolve their own key one async hop later — by then
  // the tokens may be gone, so that write can land in the `anon` bucket and
  // leave `routeflow-pod-store:<userId>` intact, resurrecting the cleared
  // captures at the next sign-in. Deleting the key outright here makes the
  // clear deterministic: the late write may only ever re-create the reset
  // (empty) state, never the old blob. A null id clears the anon bucket,
  // which is harmless.
  await Promise.all([
    clearUserScopedStorage(POD_STORE_NAME, userId),
    clearUserScopedStorage(RUN_SETTLEMENT_STORE_NAME, userId),
    clearUserScopedStorage(STOP_CART_STORE_NAME, userId),
  ]);

  // (6) Sweep the per-ORDER keyspaces. These are not one key per store but one
  // key per order, so the only way to clear them is to enumerate and match a
  // prefix. Same B136/B137/B140 reason as (5): a staged order edit the last
  // operator left behind must never be offered for restore to the next login
  // on a shared device.
  await clearStorageByPrefix(editItemsSnapshotUserPrefix(userId));
}

/**
 * Remove every AsyncStorage key under `prefix`. Best-effort BY CONTRACT — a
 * storage failure (an unavailable native module, a platform quirk, an older
 * mock without `getAllKeys`) must degrade to "not swept", never turn a
 * sign-out into a thrown error the way step (5)'s unguarded removes cannot.
 */
async function clearStorageByPrefix(prefix: string): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = (keys ?? []).filter((key) => key.startsWith(prefix));
    if (mine.length > 0) await AsyncStorage.multiRemove(mine);
  } catch {
    // Best-effort — never break sign-out on a storage failure.
  }
}

interface ResettableState {
  reset?: () => void;
}

function resetIfPresent(state: unknown): void {
  (state as ResettableState).reset?.();
}
