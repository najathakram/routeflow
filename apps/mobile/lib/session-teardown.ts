import { queryClient } from "./query-client";
import { stopLocationTracking } from "./location-tracker";
import { getStoredUser } from "./auth";
import { clearUserScopedStorage } from "./user-scoped-storage";
import { POD_STORE_NAME, usePodStore } from "../store/podStore";
import { RUN_SETTLEMENT_STORE_NAME, useRunSettlementStore } from "../store/runSettlementStore";
import { useMileageStore } from "../store/mileageStore";
import { useRouteStore } from "../store/routeStore";
import { useDeliveryPlanStore } from "../store/delivery-plan-store";
import { useListUiStore } from "../store/listUiStore";
import { useProductPickerStore } from "../store/productPickerStore";

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
 *  - B140 — the query cache and the 7 user-scoped stores below survived a
 *    sign-out, so the next login on the same device could see the prior
 *    user's data flash on screen.
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

  // (4) Reset the 7 user-scoped stores. All 7 expose a `reset()`;
  // `resetIfPresent` stays a defensive no-op so a store that ever loses one
  // can never turn a sign-out into a crash.
  resetIfPresent(usePodStore.getState());
  resetIfPresent(useRunSettlementStore.getState());
  resetIfPresent(useMileageStore.getState());
  resetIfPresent(useRouteStore.getState());
  resetIfPresent(useDeliveryPlanStore.getState());
  resetIfPresent(useListUiStore.getState());
  resetIfPresent(useProductPickerStore.getState());

  // (5) Remove the two PERSISTED user-scoped blobs by the id resolved in (0).
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
  ]);
}

interface ResettableState {
  reset?: () => void;
}

function resetIfPresent(state: unknown): void {
  (state as ResettableState).reset?.();
}
